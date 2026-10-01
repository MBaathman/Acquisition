import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IntelligenceService,
  KeywordReplyClassifier,
  LlmRefusalError,
  LlmReplyClassifier,
  ManualClock,
  PlanService,
  applyAnswer,
  buildCampaignConfig,
  createMemoryStore,
  extractGoal,
  planFromRequest,
  simulateFirstRun,
  understandGoal,
  understandRequest,
  type BuilderPresets,
  type Knowledge,
  type LlmProvider,
  type LlmRequest,
  type PlannerContext,
} from "../src/index.js";
import { DATASPEAKS, START, loadWith } from "./helpers.js";

const root = join(import.meta.dirname, "..", "presets");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const presets: BuilderPresets = { outcomes: read("outcomes.json").presets, intents: read("replies.json").intents };
const knowledge: Knowledge = read("knowledge.json");
const ctx: PlannerContext = { knowledge, outcomes: presets.outcomes, clients: [{ id: "c-dataspeaks", name: "DataSpeaks" }], locale: "ar" };

const AGENCIES = "أبغى 50 عميل مدفوع لـ DataSpeaks من وكالات التسويق في الإمارات";
const ENTERPRISE = "20 اجتماع مؤهل لـ Tatimmah مع شركات كبيرة في السعودية";
const LUXURY = "Qualified Leads لعقارات سكنية فاخرة في الرياض";

/** A scripted provider that records what it was asked. */
class FakeProvider implements LlmProvider {
  readonly name = "fake";
  calls: LlmRequest<unknown>[] = [];
  constructor(private readonly answer: (req: LlmRequest<unknown>) => unknown) {}
  async complete<T>(req: LlmRequest<T>) {
    this.calls.push(req as LlmRequest<unknown>);
    return { output: this.answer(req as LlmRequest<unknown>) as T, model: "fake-1", usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}

function service(provider?: LlmProvider) {
  const store = createMemoryStore();
  const clock = new ManualClock(START);
  return { store, clock, ai: new IntelligenceService({ provider, calls: store.llmCalls, cache: store.llmCache, clock }) };
}

describe("agent planner (one sentence → plan)", () => {
  it("understands the agency example and asks one question", () => {
    const plan = planFromRequest(AGENCIES, ctx);
    expect(plan.extraction).toMatchObject({ clientName: "DataSpeaks", outcome: "paid_subscriber", goal: 50, countries: ["AE"], archetype: "marketing_agencies" });
    expect(plan.understanding.client).toMatchObject({ id: "c-dataspeaks", existing: true });
    expect(plan.questions.map((q) => q.id)).toEqual(["region_focus"]);
    expect(plan.questions[0]!.options.map((o) => o.label)).toEqual(["كل الإمارات", "دبي وأبوظبي أولاً", "حدد لي"]);
    expect(plan.strategy).toMatchObject({ maxScore: 95, threshold: 70, touches: 2, autonomy: "human_approval", messageLanguage: "en" });
  });

  it("understands the enterprise example with its personas", () => {
    const plan = planFromRequest(ENTERPRISE, ctx);
    expect(plan.extraction).toMatchObject({ clientName: "Tatimmah", outcome: "qualified_meeting", goal: 20, countries: ["SA"], archetype: "enterprise" });
    expect(plan.understanding.client.existing).toBe(false);
    expect(plan.draft.audience.titles).toEqual(expect.arrayContaining(["Marketing Director", "Head of Communications", "Chief Strategy Officer"]));
    expect(plan.questions.map((q) => q.id)).toEqual(["public_sector"]);
  });

  it("understands the property example and asks for the goal and a minimum budget", () => {
    const plan = planFromRequest(LUXURY, ctx);
    expect(plan.extraction).toMatchObject({ outcome: "qualified_lead", goal: null, countries: ["SA"], cities: ["Riyadh"], archetype: "luxury_residential" });
    expect(plan.understanding.client.placeholder).toBe(true);
    expect(plan.draft.audience.targetType).toBe("individual");
    expect(plan.questions.map((q) => q.id)).toEqual(["goal", "min_budget"]);
  });

  it("understands English sentences too", () => {
    const x = extractGoal("50 paid customers for DataSpeaks from marketing agencies in the UAE", { ...ctx, locale: "en" });
    expect(x).toMatchObject({ clientName: "DataSpeaks", outcome: "paid_subscriber", goal: 50, countries: ["AE"], archetype: "marketing_agencies" });
  });

  it("never asks more than two questions", () => {
    const plan = planFromRequest("أبغى عملاء", ctx);
    expect(plan.questions.length).toBeLessThanOrEqual(2);
    expect(plan.assumptions.some((a) => a.id === "market")).toBe(true);
  });

  it("re-plans from answers without re-reading the sentence", () => {
    let plan = planFromRequest(AGENCIES, ctx);
    plan = applyAnswer(plan, "region_focus", "focus", ctx);
    expect(plan.status).toBe("ready");
    expect(plan.understanding.market.cities).toEqual(["Dubai", "Abu Dhabi"]);
    expect(plan.draft.campaign.name).toBe("استقطاب وكالات دبي وأبوظبي");

    let luxury = planFromRequest(LUXURY, ctx);
    luxury = applyAnswer(applyAnswer(luxury, "goal", "30", ctx), "min_budget", "5000000", ctx);
    expect(luxury.understanding.outcome.goal).toBe(30);
    expect(luxury.draft.qualification.criteria.find((c) => c.check?.type === "budget")?.check).toEqual({ type: "budget", min: 5_000_000 });
  });

  it.each([AGENCIES, ENTERPRISE, LUXURY])("produces an engine-valid config: %s", (sentence) => {
    const cfg = buildCampaignConfig(planFromRequest(sentence, ctx).draft, presets);
    expect(cfg.outreach.sequence.length).toBe(2);
    expect(cfg.autonomy.level).toBe("human_approval");
  });

  it("runs on the real engine: one sentence → drafted messages waiting for approval", async () => {
    let plan = planFromRequest(AGENCIES, ctx);
    plan = applyAnswer(plan, "region_focus", "all", ctx);
    const cfg = buildCampaignConfig(plan.draft, presets);
    const { counts, snapshot } = await simulateFirstRun(plan, cfg, knowledge, { start: START });
    expect(counts.discovered).toBe(40);
    expect(counts.fit).toBeGreaterThan(0);
    expect(counts.messagesReady).toBeGreaterThan(0);
    expect(snapshot.outreach.filter((a) => a.status === "pending_approval").every((a) => a.mode === "approval")).toBe(true);
    expect(snapshot.outreach.some((a) => a.status === "succeeded")).toBe(false); // nothing is sent before approval
  });
});

describe("intelligence layer", () => {
  it("skips the model when rules understood the request", async () => {
    const provider = new FakeProvider(() => { throw new Error("should not be called"); });
    const { ai, store } = service(provider);
    const res = await understandRequest(AGENCIES, ctx, ai);
    expect(res.understoodBy).toBe("rules");
    expect(provider.calls).toHaveLength(0);
    expect((await store.llmCalls.find(() => true)).map((c) => c.status)).toEqual(["skipped"]);
  });

  it("asks the model only for what rules missed, keeps only known keys, and caches the answer", async () => {
    const provider = new FakeProvider(() => ({
      clientName: "Acme", outcome: "paid_subscriber", goal: 30, countries: ["KW", "XX"], cities: [], archetype: "marketing_agencies",
      audience: null, cta: null, autonomy: null,
    }));
    const { ai } = service(provider);
    const sentence = "we want thirty paying shops in kuwait for Acme";
    expect(extractGoal(sentence, ctx).archetype).toBeNull();
    const first = await understandRequest(sentence, ctx, ai);
    expect(first.understoodBy).toBe("llm");
    expect(first.extraction).toMatchObject({ clientName: "Acme", outcome: "paid_subscriber", countries: ["KW"], archetype: "marketing_agencies", goal: 30 });
    await understandRequest(sentence, ctx, ai);
    expect(provider.calls).toHaveLength(1); // second time served from cache
    const usage = await ai.usage();
    expect(usage).toMatchObject({ calls: 2, modelCalls: 1, cacheHits: 1, inputTokens: 120, outputTokens: 30 });
    expect(usage.byPrompt.understand_goal).toMatchObject({ calls: 2, modelCalls: 1 });
  });

  it("falls back to rules on refusal, invalid output or no provider — and logs it", async () => {
    const refusing = service(new FakeProvider(() => { throw new LlmRefusalError("declined"); }));
    const r1 = await refusing.ai.run(understandGoal, { request: "x", locale: "en", outcomes: [], regions: [], archetypes: [], clients: [] }, { fallback: () => extractGoal("x", ctx) });
    expect(r1.source).toBe("rules");
    expect((await refusing.store.llmCalls.find(() => true))[0]).toMatchObject({ status: "refused", fallback: true });

    const invalid = service(new FakeProvider(() => ({ nonsense: true })));
    const r2 = await invalid.ai.run(understandGoal, { request: "y", locale: "en", outcomes: [], regions: [], archetypes: [], clients: [] }, { fallback: () => extractGoal("y", ctx) });
    expect(r2.source).toBe("rules");
    expect((await invalid.store.llmCache.find(() => true))).toHaveLength(0); // invalid answers are never cached

    const none = service();
    const r3 = await none.ai.run(understandGoal, { request: "z", locale: "en", outcomes: [], regions: [], archetypes: [], clients: [] }, { fallback: () => extractGoal("z", ctx) });
    expect(r3.source).toBe("rules");
    expect((await none.store.llmCalls.find(() => true))[0]).toMatchObject({ status: "rules", provider: "rules" });
  });

  it("reply classification rejects intents the campaign does not define", async () => {
    const cfg = await loadWith(DATASPEAKS);
    const prospect = {} as never;
    const unknown = service(new FakeProvider(() => ({ intent: "made_up", confidence: 0.99, extracted: [] })));
    const c1 = await new LlmReplyClassifier(unknown.ai, new KeywordReplyClassifier()).classify({ campaign: cfg, prospect, text: "Not interested, thanks" });
    expect(c1.intent).toBe("not_interested");

    const known = service(new FakeProvider(() => ({ intent: "interested", confidence: 0.91, extracted: [{ key: "team_size", value: "15" }] })));
    const c2 = await new LlmReplyClassifier(known.ai, new KeywordReplyClassifier()).classify({ campaign: cfg, prospect, text: "Sounds good, we are 15 people" });
    expect(c2).toEqual({ intent: "interested", confidence: 0.91, extracted: { team_size: "15" } });
  });
});

describe("plan service (persisted plans)", () => {
  it("persists the plan, answers and approves without any model call", async () => {
    const provider = new FakeProvider(() => { throw new Error("no model call expected"); });
    const { store, clock, ai } = service(provider);
    const plans = new PlanService({ plans: store.plans, presets, clock, ai, ctx: (locale) => ({ ...ctx, locale }) });
    const plan = await plans.create(ENTERPRISE, "ar");
    expect(await plans.get(plan.id)).toMatchObject({ id: plan.id, status: "needs_input" });
    await plans.setAssumption(plan.id, "a1", "accepted");
    const answered = await plans.answer(plan.id, "public_sector", "private");
    expect(answered.understanding.audience.companyTypes).toEqual(["شركة كبرى"]);
    expect(answered.assumptions.find((a) => a.id === "a1")?.status).toBe("accepted");
    const { plan: approved, config } = await plans.approve(plan.id);
    expect(approved.status).toBe("approved");
    expect(approved.assumptions.every((a) => a.status !== "proposed")).toBe(true);
    expect(config.outcome.key).toBe("qualified_meeting");
    expect(provider.calls).toHaveLength(0);
  });
});
