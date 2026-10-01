import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AcquisitionAgent, IntelligenceService, ManualClock, createMemoryStore, simulateFirstRun,
  type AgentCard, type BuilderPresets, type Knowledge, type LlmProvider, type LlmRequest,
} from "../src/index.js";
import { START } from "./helpers.js";

const root = join(import.meta.dirname, "..", "presets");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const presets: BuilderPresets = { outcomes: read("outcomes.json").presets, intents: read("replies.json").intents };
const knowledge: Knowledge = read("knowledge.json");

function setup(opts: { provider?: LlmProvider; clients?: { id: string; name: string }[] } = {}) {
  const store = createMemoryStore();
  const clock = new ManualClock(START);
  const ai = new IntelligenceService({ provider: opts.provider, calls: store.llmCalls, cache: store.llmCache, clock });
  let executions = 0;
  const agent = new AcquisitionAgent({
    conversations: store.conversations, plans: store.plans, runs: store.runs, approvals: store.approvals,
    planner: (locale) => ({ knowledge, outcomes: presets.outcomes, clients: opts.clients ?? [], locale }),
    presets, clock, ai,
    execute: async (plan, cfg) => { executions++; return (await simulateFirstRun(plan, cfg, knowledge, { start: START })).snapshot; },
  });
  return { agent, store, ai, executions: () => executions };
}
const last = (c: { messages: { role: string; text: string; cards?: AgentCard[] }[] }) => c.messages.at(-1)!;
const card = <K extends AgentCard["kind"]>(c: { messages: { cards?: AgentCard[] }[] }, kind: K) => last(c as never as { messages: { role: string; text: string; cards?: AgentCard[] }[] }).cards?.find((x): x is Extract<AgentCard, { kind: K }> => x.kind === kind);

describe("agent conversation — the final product test", () => {
  it("one sentence → plan → change by chat → start → results → policy, without any form", async () => {
    const { agent, store, ai, executions } = setup();

    // 1. One sentence.
    let conv = await agent.start("أبغى 100 عميل مدفوع لـDataSpeaks في الإمارات من وكالات التسويق.", "ar");
    let plan = (await store.plans.get(conv.planId!))!;
    expect(plan.understanding).toMatchObject({ client: { name: "DataSpeaks" }, outcome: { preset: "paid_subscriber", goal: 100 }, market: { countries: ["AE"] } });
    expect(last(conv).text).toContain("فهمتك");
    expect(last(conv).text).toContain("هدفك: 100");
    expect(card(conv, "questions")?.questions.map((q) => q.id)).toEqual(["company_size"]);

    // 2. Change it in plain language.
    conv = (await agent.send(conv.id, "خلها السعودية وركز على الرياض")).conversation;
    plan = (await store.plans.get(conv.planId!))!;
    expect(plan.understanding.market).toMatchObject({ countries: ["SA"], cities: ["Riyadh"] });
    expect(card(conv, "diff")?.rows.map((r) => r.key)).toContain("market");
    expect(executions()).toBe(0); // nothing runs before the user says so

    // 3. Start.
    conv = (await agent.send(conv.id, "ابدأ البحث")).conversation;
    const run = (await store.runs.get(conv.campaignId!))!;
    expect(run.status).toBe("running");
    expect(run.counts.discovered).toBeGreaterThanOrEqual(100);
    expect(run.counts.messagesReady).toBeGreaterThan(0);
    expect(run.activity.map((a) => a.kind)).toContain("needs_you");
    expect(run.snapshot.outreach.some((a) => a.status === "succeeded")).toBe(false); // nothing sent
    expect(card(conv, "progress")?.steps.length).toBe(5);

    // 4. Results.
    conv = (await agent.send(conv.id, "ورني وش لقيت")).conversation;
    expect(card(conv, "prospects")?.items.length).toBe(5);
    expect(card(conv, "prospects")!.items[0]!.reasons.length).toBeGreaterThan(0);

    // 5. Policy.
    conv = (await agent.send(conv.id, "جهز التواصل لكن لا ترسل أي شيء بدون موافقتي")).conversation;
    expect(last(conv).text).toContain("لا يُرسل أي شيء قبل موافقتك");
    expect(last(conv).text).toContain("الرسائل جاهزة");
    expect((await store.runs.get(run.id))!.cfg.autonomy.level).toBe("human_approval");

    // Every user message carries structured intents; no model was needed.
    expect(conv.messages.filter((m) => m.role === "user").every((m) => m.intents?.length && m.intents[0]!.type !== "unknown")).toBe(true);
    expect((await ai.usage()).modelCalls).toBe(0);
  });

  it("answers a question typed in natural language", async () => {
    const { agent, store } = setup();
    let conv = await agent.start("أبغى 100 عميل مدفوع لـDataSpeaks من وكالات التسويق في الإمارات", "ar");
    conv = (await agent.send(conv.id, "جميع الأحجام")).conversation;
    const plan = (await store.plans.get(conv.planId!))!;
    expect(plan.questions).toHaveLength(0);
    expect(plan.strategy.size).toEqual({ min: null, max: null });
    expect(card(conv, "actions")?.actions[0]?.say).toBe("ابدأ البحث");
  });

  it("major changes to a running campaign need approval; minor ones apply", async () => {
    const { agent, store, executions } = setup();
    let conv = await agent.start("20 اجتماع مؤهل لـ Tatimmah مع شركات كبيرة في السعودية", "ar");
    conv = (await agent.send(conv.id, "ابدأ")).conversation;
    const id = conv.campaignId!;

    conv = (await agent.send(conv.id, "خل الرسائل بالعربي واستخدم البريد فقط")).conversation;
    const cfg = (await store.runs.get(id))!.cfg;
    expect(cfg.outreach.channels.map((c) => c.key)).toEqual(["email"]);
    expect(await store.approvals.find(() => true)).toHaveLength(0);

    conv = (await agent.send(conv.id, "ارفع درجة التأهيل إلى 90")).conversation;
    const [approval] = await store.approvals.find((a) => a.status === "pending");
    expect(approval!.rows.map((r) => r.key)).toEqual(["threshold"]);
    expect(card(conv, "diff")?.approvalId).toBe(approval!.id);
    const before = executions();

    conv = (await agent.send(conv.id, "اعتمد")).conversation;
    expect((await store.approvals.get(approval!.id))!.status).toBe("approved");
    expect((await store.runs.get(id))!.cfg.outreach.minScore).toBe(90);
    expect(executions()).toBe(before + 1); // recalculated once
    expect(last(conv).text).toContain("اعتمدت التعديل");
  });

  it("pauses, resumes, explains and counts", async () => {
    const { agent, store } = setup();
    let conv = await agent.start("Qualified Leads لعقارات سكنية فاخرة في الرياض", "ar");
    conv = (await agent.send(conv.id, "ابدأ البحث")).conversation;
    expect(last(conv).text).toContain("افترضت"); // open questions took their defaults
    conv = (await agent.send(conv.id, "وقف الحملة")).conversation;
    expect((await store.runs.get(conv.campaignId!))!.status).toBe("paused");
    conv = (await agent.send(conv.id, "استأنف")).conversation;
    expect((await store.runs.get(conv.campaignId!))!.status).toBe("running");
    conv = (await agent.send(conv.id, "ليش اخترت هذي الشركات؟")).conversation;
    expect(card(conv, "bullets")!.items.length).toBeGreaterThan(0);
    conv = (await agent.send(conv.id, "كم شركة عندك؟")).conversation;
    expect(card(conv, "status")!.counts.discovered).toBeGreaterThan(0);
  });

  it("asks before linking a near-identical existing client", async () => {
    const { agent, store } = setup({ clients: [{ id: "c-dataspeaks", name: "DataSpeaks" }] });
    let conv = await agent.start("أبغى 50 عميل مدفوع لـ Data Speaks من وكالات التسويق في الإمارات", "ar");
    expect(card(conv, "questions")!.questions[0]!.text).toContain("هل تقصد DataSpeaks");
    conv = (await agent.send(conv.id, "نعم")).conversation;
    expect((await store.plans.get(conv.planId!))!.understanding.client).toMatchObject({ id: "c-dataspeaks", existing: true });
  });

  it("a different goal opens a new conversation", async () => {
    const { agent } = setup();
    const first = await agent.start("أبغى 100 عميل مدفوع لـDataSpeaks من وكالات التسويق في الإمارات", "ar");
    const { conversation } = await agent.send(first.id, "أبغى 20 اجتماع مؤهل لـTatimmah مع شركات كبيرة في السعودية");
    expect(conversation.id).not.toBe(first.id);
    expect(conversation.title).toContain("Tatimmah");
  });

  it("uses the model only for messages the rules can't read, and keeps its output in bounds", async () => {
    const calls: LlmRequest<unknown>[] = [];
    const provider: LlmProvider = {
      name: "fake",
      async complete<T>(req: LlmRequest<T>) {
        calls.push(req as LlmRequest<unknown>);
        const output = { intents: [{ type: "update_plan", questionId: null, value: null, topic: null, changes: { countries: ["KW", "ZZ"], cities: null, goal: null, sizeMin: null, sizeMax: null, minClients: null, email: null, linkedin: null, language: null, threshold: null, decisionMakersOnly: null, autonomy: null } }] };
        return { output: output as T, model: "fake", usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    };
    const { agent, store } = setup({ provider });
    let conv = await agent.start("أبغى 100 عميل مدفوع لـDataSpeaks من وكالات التسويق في الإمارات", "ar");
    conv = (await agent.send(conv.id, "ابدأ")).conversation;
    expect(calls.filter((c) => c.promptId === "interpret_message")).toHaveLength(0);
    conv = (await agent.send(conv.id, "honestly the Kuwaiti side looks more promising to me")).conversation; // rules: no intent
    expect(calls.filter((c) => c.promptId === "interpret_message")).toHaveLength(1);
    const [approval] = await store.approvals.find(() => true);
    expect(approval!.changes).toEqual({ countries: ["KW"] }); // unknown "ZZ" dropped; running → approval
  });
});
