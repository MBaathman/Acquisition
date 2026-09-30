import type { CampaignConfig } from "../config/schema.js";
import type { CampaignState, Contact, Message, OutcomeRecord, Prospect } from "../domain/types.js";

/**
 * Learning from results: per-arm stats (template variant, channel, tier) built
 * from outbound touches, positive replies and outcomes. Used to pick variants
 * and channels (UCB1 bandit) and to generate optimization recommendations.
 */
export interface ArmStats {
  sent: number;
  positive: number;
  outcomes: number;
}

const empty = (): ArmStats => ({ sent: 0, positive: 0, outcomes: 0 });

export interface CampaignStats {
  variants: Map<string, ArmStats>; // `${template}:${variant}`
  channels: Map<string, ArmStats>;
  tiers: Map<string, ArmStats>;
}

export function computeStats(input: {
  cfg: CampaignConfig;
  messages: Message[];
  outcomes: OutcomeRecord[];
  prospects: Prospect[];
  /** Payloads of queued, not-yet-sent touches — counted as allocations so batches spread across arms. */
  inFlight?: Record<string, unknown>[];
}): CampaignStats {
  const { cfg, messages, outcomes, prospects } = input;
  const positiveIntents = new Set(cfg.replies.intents.filter((i) => i.sentiment === "positive").map((i) => i.key));
  const stats: CampaignStats = { variants: new Map(), channels: new Map(), tiers: new Map() };
  const bump = (map: Map<string, ArmStats>, key: string | undefined, field: keyof ArmStats) => {
    if (!key) return;
    const s = map.get(key) ?? empty();
    s[field] += 1;
    map.set(key, s);
  };
  const tierOf = new Map(prospects.map((p) => [p.id, p.tier]));
  const byProspect = new Map<string, Message[]>();
  for (const m of [...messages].sort((a, b) => a.at.localeCompare(b.at))) {
    byProspect.set(m.prospectId, [...(byProspect.get(m.prospectId) ?? []), m]);
  }

  for (const [prospectId, thread] of byProspect) {
    let lastOutbound: Message | undefined;
    let tierCounted = false;
    for (const m of thread) {
      if (m.direction === "outbound" && m.kind === "sequence") {
        bump(stats.variants, `${m.templateKey}:${m.variantKey}`, "sent");
        bump(stats.channels, m.channel, "sent");
        if (!tierCounted) bump(stats.tiers, tierOf.get(prospectId), "sent");
        tierCounted = true;
        lastOutbound = m;
      } else if (m.direction === "inbound" && m.intent && positiveIntents.has(m.intent) && lastOutbound) {
        bump(stats.variants, `${lastOutbound.templateKey}:${lastOutbound.variantKey}`, "positive");
        bump(stats.channels, lastOutbound.channel, "positive");
        bump(stats.tiers, tierOf.get(prospectId), "positive");
        lastOutbound = undefined; // one positive credit per touch
      }
    }
  }
  for (const a of input.inFlight ?? []) {
    if (a.templateKey) bump(stats.variants, `${a.templateKey}:${a.variantKey}`, "sent");
    if (typeof a.channel === "string") bump(stats.channels, a.channel, "sent");
  }
  for (const o of outcomes.filter((o) => o.counted)) {
    const t = o.attribution.lastTouch;
    if (t?.templateKey) bump(stats.variants, `${t.templateKey}:${t.variantKey}`, "outcomes");
    if (t) bump(stats.channels, t.channel, "outcomes");
    bump(stats.tiers, o.attribution.tier, "outcomes");
  }
  return stats;
}

/** Positive-reply rate with outcomes weighted heavier. */
const reward = (s: ArmStats) => (s.sent ? Math.min(1, (s.positive + 2 * s.outcomes) / s.sent) : 0);

/** UCB1 selection; untried arms go first (in config order). */
export function pickArm(keys: string[], stats: Map<string, ArmStats>): string {
  const untried = keys.find((k) => !stats.get(k)?.sent);
  if (untried) return untried;
  const total = keys.reduce((n, k) => n + (stats.get(k)?.sent ?? 0), 0);
  let best = keys[0]!;
  let bestScore = -Infinity;
  for (const k of keys) {
    const s = stats.get(k)!;
    const ucb = reward(s) + Math.sqrt((2 * Math.log(total)) / s.sent);
    if (ucb > bestScore) {
      bestScore = ucb;
      best = k;
    }
  }
  return best;
}

export function selectVariant(cfg: CampaignConfig, state: CampaignState, templateKey: string, stats: CampaignStats) {
  const template = cfg.personalization.templates[templateKey];
  if (!template) throw new Error(`unknown template '${templateKey}'`);
  const active = template.variants.filter((v) => !state.disabledVariants.includes(`${templateKey}:${v.key}`));
  const pool = active.length ? active : template.variants;
  const chosen = pickArm(pool.map((v) => `${templateKey}:${v.key}`), stats.variants);
  return pool.find((v) => `${templateKey}:${v.key}` === chosen)!;
}

/** Reachable channels for a contact, in config order. */
export function reachableChannels(cfg: CampaignConfig, contact: Contact): string[] {
  return cfg.outreach.channels
    .filter((c) => contact.handles[c.handle] && (!c.consentRequired || contact.consents.includes(c.key)))
    .map((c) => c.key);
}

export function selectChannel(cfg: CampaignConfig, contact: Contact, requested: string, stats: CampaignStats) {
  if (requested !== "auto") return requested;
  const options = reachableChannels(cfg, contact);
  if (!options.length) return cfg.outreach.channels[0]!.key; // policy check will block with a clear reason
  return pickArm(options, stats.channels);
}

export interface OptimizationProposal {
  kind: string;
  summary: string;
  evidence: Record<string, unknown>;
  change: { op: "disable_variant"; templateKey: string; variantKey: string } | { op: "raise_min_score"; value: number };
}

/** Turn stats into concrete, explainable optimization proposals. */
export function proposeOptimizations(cfg: CampaignConfig, state: CampaignState, stats: CampaignStats): OptimizationProposal[] {
  const n = cfg.optimization.minSampleSize;
  const out: OptimizationProposal[] = [];

  for (const [templateKey, template] of Object.entries(cfg.personalization.templates)) {
    const arms = template.variants
      .map((v) => ({ key: v.key, s: stats.variants.get(`${templateKey}:${v.key}`) ?? empty() }))
      .filter((a) => !state.disabledVariants.includes(`${templateKey}:${a.key}`));
    if (arms.length < 2 || arms.some((a) => a.s.sent < n)) continue;
    const ranked = [...arms].sort((a, b) => reward(b.s) - reward(a.s));
    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;
    if (reward(best.s) > 0 && reward(worst.s) < reward(best.s) * 0.5) {
      out.push({
        kind: "variant_underperforming",
        summary: `Retire variant '${worst.key}' of '${templateKey}': ${(reward(worst.s) * 100).toFixed(1)}% vs ${(reward(best.s) * 100).toFixed(1)}% for '${best.key}'`,
        evidence: { best: { key: best.key, ...best.s }, worst: { key: worst.key, ...worst.s } },
        change: { op: "disable_variant", templateKey, variantKey: worst.key },
      });
    }
  }

  const tiers = [...cfg.scoring.tiers].sort((a, b) => a.min - b.min);
  const currentMin = state.minScoreOverride ?? cfg.outreach.minScore;
  for (let i = 0; i < tiers.length - 1; i++) {
    const tier = tiers[i]!;
    const next = tiers[i + 1]!;
    const s = stats.tiers.get(tier.key);
    if (next.min <= currentMin || !s || s.sent < n) continue;
    if (s.positive === 0 && s.outcomes === 0) {
      out.push({
        kind: "tier_not_converting",
        summary: `${tier.label} produced no positive replies or outcomes from ${s.sent} contacted prospects — focus on score ≥ ${next.min}`,
        evidence: { tier: tier.key, ...s },
        change: { op: "raise_min_score", value: next.min },
      });
      break;
    }
  }
  return out;
}
