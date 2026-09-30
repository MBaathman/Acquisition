import type { CampaignConfig } from "../config/schema.js";
import type { Store } from "../store/store.js";

/**
 * The client-facing view. Clients see their desired outcome, progress,
 * results, pipeline, attribution, recommendations and exceptions — never
 * the internal workflow.
 */
export interface ClientReport {
  client: { id: string; name: string };
  campaign: { id: string; name: string; status: string; autonomy: string };
  outcome: {
    key: string;
    label: string;
    unit: string;
    achieved: number;
    target?: number;
    progressPct?: number;
    value: { amount: number; currency: string } | null;
    uncounted: number;
  };
  pipeline: { stage: string; label: string; count: number }[];
  conversion: { from: string; to: string; rate: number }[];
  results: { at: string; prospectId?: string; value?: number }[];
  attribution: {
    byChannel: Record<string, number>;
    byStep: Record<string, number>;
    byVariant: Record<string, number>;
    byPersona: Record<string, number>;
  };
  activity: { prospects: number; contacted: number; replied: number; positiveReplies: number; messagesSent: number };
  recommendations: { id: string; summary: string; status: string }[];
  attention: {
    pendingApprovals: number;
    exceptions: { id: string; kind: string; severity: string; reason: string; prospectId?: string; at: string }[];
  };
  generatedAt: string;
}

const tally = (map: Record<string, number>, key: string | undefined) => {
  if (key) map[key] = (map[key] ?? 0) + 1;
};

export async function buildClientReport(input: { cfg: CampaignConfig; store: Store; now: Date }): Promise<ClientReport> {
  const { cfg, store, now } = input;
  const id = cfg.campaign.id;
  const [prospects, outcomes, messages, recs, exceptions, pending] = await Promise.all([
    store.prospects.find((p) => p.campaignId === id),
    store.outcomes.find((o) => o.campaignId === id),
    store.messages.find((m) => m.campaignId === id),
    store.recommendations.find((r) => r.campaignId === id && r.status === "open"),
    store.exceptions.find((e) => e.campaignId === id && e.status === "open"),
    store.actions.find((a) => a.campaignId === id && a.status === "pending_approval"),
  ]);

  const counted = outcomes.filter((o) => o.counted);
  const target = cfg.outcome.target?.count;
  const valueTotal = counted.reduce((sum, o) => sum + (o.value?.amount ?? 0), 0);

  const stageIndex = new Map(cfg.funnel.stages.map((s, i) => [s.key, i]));
  const lostStage = cfg.funnel.stages.find((s) => s.milestone === "lost")?.key;
  // "reached" counts: a prospect in a later stage has passed through earlier ones (lost excluded).
  const reached = (stage: string) =>
    prospects.filter((p) => p.stage !== lostStage && (stageIndex.get(p.stage) ?? -1) >= (stageIndex.get(stage) ?? Infinity)).length;

  const conversion: ClientReport["conversion"] = [];
  const funnel = cfg.funnel.stages.filter((s) => s.key !== lostStage);
  for (let i = 0; i < funnel.length - 1; i++) {
    const from = funnel[i]!.key;
    const to = funnel[i + 1]!.key;
    const base = reached(from);
    conversion.push({ from, to, rate: base ? reached(to) / base : 0 });
  }

  const attribution: ClientReport["attribution"] = { byChannel: {}, byStep: {}, byVariant: {}, byPersona: {} };
  for (const o of counted) {
    const t = o.attribution.lastTouch;
    tally(attribution.byChannel, t?.channel);
    tally(attribution.byStep, t?.stepKey);
    tally(attribution.byVariant, t?.templateKey && `${t.templateKey}:${t.variantKey}`);
    tally(attribution.byPersona, o.attribution.persona);
  }

  const positive = new Set(cfg.replies.intents.filter((i) => i.sentiment === "positive").map((i) => i.key));
  const inbound = messages.filter((m) => m.direction === "inbound");

  return {
    client: { id: cfg.client.id, name: cfg.client.name },
    campaign: { id, name: cfg.campaign.name, status: cfg.campaign.status, autonomy: cfg.autonomy.level },
    outcome: {
      key: cfg.outcome.key,
      label: cfg.outcome.label,
      unit: cfg.outcome.unit,
      achieved: counted.length,
      target,
      progressPct: target ? Math.round((counted.length / target) * 1000) / 10 : undefined,
      value: cfg.outcome.value ? { amount: valueTotal, currency: cfg.outcome.value.currency } : null,
      uncounted: outcomes.length - counted.length,
    },
    pipeline: cfg.funnel.stages.map((s) => ({ stage: s.key, label: s.label, count: prospects.filter((p) => p.stage === s.key).length })),
    conversion,
    results: counted
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 20)
      .map((o) => ({ at: o.at, prospectId: o.prospectId, value: o.value?.amount })),
    attribution,
    activity: {
      prospects: prospects.length,
      contacted: prospects.filter((p) => p.milestones.contacted).length,
      replied: new Set(inbound.map((m) => m.prospectId)).size,
      positiveReplies: inbound.filter((m) => m.intent && positive.has(m.intent)).length,
      messagesSent: messages.filter((m) => m.direction === "outbound").length,
    },
    recommendations: recs.map((r) => ({ id: r.id, summary: r.summary, status: r.status })),
    attention: {
      pendingApprovals: pending.length,
      exceptions: exceptions
        .sort((a, b) => b.at.localeCompare(a.at))
        .map((e) => ({ id: e.id, kind: e.kind, severity: e.severity, reason: e.reason, prospectId: e.prospectId, at: e.at })),
    },
    generatedAt: now.toISOString(),
  };
}
