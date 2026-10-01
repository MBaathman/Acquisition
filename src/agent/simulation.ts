import { AttributeResearchProvider, FixtureContactFinder, KeywordReplyClassifier, ManualClock, OutboxSender, StaticProspectSource } from "../adapters/defaults.js";
import type { DiscoveredProspect, ReplyClassifier } from "../adapters/ports.js";
import type { CampaignConfig } from "../config/schema.js";
import { AcquisitionEngine } from "../engine/engine.js";
import type { InMemoryQueue } from "../runtime/queue.js";
import type { CampaignPlan, Knowledge } from "./planner.js";
import { snapshotCampaign } from "./snapshot.js";

/**
 * SIMULATION ONLY. Generates fictional prospects that look like the plan's
 * audience and runs the real engine over them, so a new campaign shows the
 * real pipeline (discovery → research → scoring → drafted messages waiting
 * for approval) without contacting anyone. Every name and domain is fictional
 * (`.demo`); nothing is sent.
 */

const FIRST = ["Sara", "Khalid", "Noura", "Faisal", "Reem", "Omar", "Lama", "Abdullah", "Hessa", "Turki", "Maha", "Yousef", "Dana", "Fahad", "Rana", "Saad"];
const LAST = ["Al Harbi", "Al Mansoori", "Al Qahtani", "Al Suwaidi", "Al Otaibi", "Al Falasi", "Al Shamsi", "Al Ghamdi", "Al Nuaimi", "Haddad"];
const SOURCES = [
  { source: "Company website", path: "/about", confidence: 0.9 },
  { source: "LinkedIn company page", path: "", confidence: 0.8 },
  { source: "Industry directory", path: "", confidence: 0.85 },
  { source: "Recent news", path: "/news", confidence: 0.75 },
];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return {
    next,
    pick: <T,>(a: readonly T[]) => a[Math.floor(next() * a.length)]!,
    chance: (p: number) => next() < p,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function simulatedProspects(plan: CampaignPlan, cfg: CampaignConfig, knowledge: Knowledge, n: number, seed = 11): DiscoveredProspect[] {
  const r = rng(seed);
  const arch = knowledge.archetypes.find((a) => a.key === plan.understanding.audience.archetype) ?? knowledge.archetypes.find((a) => a.fallback)!;
  const regions = plan.understanding.market.countries.map((c) => knowledge.regions.find((x) => x.code === c)).filter(Boolean);
  const cityPool = (country: string) => {
    if (plan.understanding.market.cities.length) return plan.understanding.market.cities;
    const reg = regions.find((x) => x!.code === country);
    return reg?.cities.length ? reg.cities.map((c) => c.key) : [country];
  };
  const questions = cfg.research.questions;
  const titles = arch.titles.en.length ? [...arch.titles.en, "Account Manager", "Analyst"] : ["Owner"];
  const sizeMin = arch.size?.min ?? 10;
  const sizeMax = arch.size?.max ?? sizeMin * 20;
  const nameA = arch.namePool?.a.length ? arch.namePool.a : ["Nova", "Summit", "Orbit", "Cedar"];
  const nameB = arch.namePool?.b.length ? arch.namePool.b : ["Group", "Co"];
  const budgets = arch.budgetOptions?.length ? [arch.budgetOptions[0]! / 2, ...arch.budgetOptions, arch.budgetOptions.at(-1)! * 1.5] : [];

  return Array.from({ length: n }, (_, i) => {
    const country = r.pick(plan.understanding.market.countries);
    // Most prospects match the market; a few don't, so the engine's fit rules have something to filter.
    const city = r.chance(0.9) ? r.pick(cityPool(country)) : "Elsewhere";
    const fn = r.pick(FIRST);
    const ln = r.pick(LAST);
    const attrs: Record<string, unknown> = {};
    const sources: Record<string, unknown> = {};
    for (const q of questions) {
      if (!r.chance(0.62)) continue;
      attrs[q.key] = plan.locale === "ar" ? "متحقق" : "Confirmed";
      // A few findings have no source: the engine discards them instead of trusting them.
      if (r.chance(0.96)) {
        const s = r.pick(SOURCES);
        sources[q.key] = { source: s.source, url: s.path ? `https://example${i}.demo${s.path}` : undefined, confidence: s.confidence };
      }
    }

    if (arch.targetType === "individual") {
      const handles: Record<string, string> = r.chance(0.85) ? { email: `${slug(fn)}.${i}@mail.demo` } : {};
      return {
        contact: {
          firstName: fn, lastName: ln, country, city, handles, consents: ["email"],
          attributes: { ...attrs, budget: budgets.length ? r.pick(budgets) : undefined, _sources: sources },
        },
      };
    }

    const name = `${r.pick(nameA)} ${r.pick(nameB)}`;
    const dom = `${slug(name)}${i}.demo`;
    const handles: Record<string, string> = {};
    if (r.chance(0.8)) handles.email = `${slug(fn)}@${dom}`;
    if (r.chance(0.65)) handles.linkedin = `linkedin.com/in/${slug(fn + ln)}${i}`;
    const findable = !Object.keys(handles).length && r.chance(0.6) ? { handles: { email: `${slug(fn)}.${slug(ln)}@${dom}` }, source: "Company website — team page" } : undefined;
    const employees = r.chance(0.85) ? Math.round(sizeMin + r.next() * (sizeMax - sizeMin)) : Math.round(sizeMax * (2 + r.next() * 3));
    return {
      account: { name, domain: dom, industry: arch.industry ?? "general", country, city, employees, attributes: { ...attrs, _sources: sources } },
      contact: { firstName: fn, lastName: ln, title: r.pick(titles), country, city, handles, attributes: findable ? { _findable: findable } : {} },
    };
  });
}

export interface SimulationResult {
  counts: {
    discovered: number;
    researched: number;
    unsourcedDiscarded: number;
    fit: number;
    needsContact: number;
    messagesReady: number;
    needsReview: number;
  };
  snapshot: Awaited<ReturnType<typeof snapshotCampaign>>;
}

/**
 * Runs the engine's first working session for a newly approved plan: one
 * discovery batch, research, scoring, contact finding and message drafting.
 * External actions stop at the approval queue, exactly as in production.
 */
export async function simulateFirstRun(
  plan: CampaignPlan,
  cfg: CampaignConfig,
  knowledge: Knowledge,
  opts: { prospects?: number; start?: Date; classifier?: ReplyClassifier } = {},
): Promise<SimulationResult> {
  const start = opts.start ?? new Date();
  const clock = new ManualClock(start);
  const outbox = new OutboxSender();
  const source = new StaticProspectSource(simulatedProspects(plan, cfg, knowledge, opts.prospects ?? 40));
  const engine = new AcquisitionEngine({
    clock,
    sources: { [cfg.discovery.source]: source },
    research: { [cfg.research.provider]: new AttributeResearchProvider() },
    contactFinders: { [cfg.contacts.finder ?? "default"]: new FixtureContactFinder() },
    channels: Object.fromEntries(cfg.outreach.channels.map((c) => [c.key, outbox])),
    classifier: opts.classifier ?? new KeywordReplyClassifier(),
  });
  const run = { ...cfg, discovery: { ...cfg.discovery, batchSize: opts.prospects ?? 40 } };
  await engine.registerCampaign(run);
  const q = engine.queue as InMemoryQueue;
  await q.runDue();
  clock.advance(60_000);
  await q.runDue();

  const id = cfg.campaign.id;
  const prospects = await engine.store.prospects.find((p) => p.campaignId === id);
  const actions = await engine.store.actions.find((a) => a.campaignId === id);
  const snapshot = await snapshotCampaign(engine, run, { start, days: 1 });
  return {
    counts: {
      discovered: prospects.length,
      researched: prospects.filter((p) => p.milestones.researched).length,
      unsourcedDiscarded: prospects.reduce((n, p) => n + (p.research?.rejected?.length ?? 0), 0),
      fit: prospects.filter((p) => p.milestones.fit).length,
      needsContact: prospects.filter((p) => p.contactStatus === "not_found" || p.contactStatus === "needs_contact").length,
      messagesReady: actions.filter((a) => a.status === "pending_approval" && (a.type === "send_message" || a.type === "follow_up")).length,
      needsReview: prospects.filter((p) => p.researchStatus === "needs_review").length,
    },
    snapshot,
  };
}
