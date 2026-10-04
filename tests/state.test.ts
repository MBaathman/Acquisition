import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcquisitionAgent, IntelligenceService, ManualClock, createMemoryStore, simulateFirstRun, type BuilderPresets, type Knowledge } from "../src/index.js";
import { START } from "./helpers.js";

const root = join(import.meta.dirname, "..", "presets");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const presets: BuilderPresets = { outcomes: read("outcomes.json").presets, intents: read("replies.json").intents };
const knowledge: Knowledge = read("knowledge.json");

async function chat(first: string) {
  const store = createMemoryStore();
  const clock = new ManualClock(START);
  const agent = new AcquisitionAgent({
    conversations: store.conversations, plans: store.plans, runs: store.runs, approvals: store.approvals,
    planner: (locale) => ({ knowledge, outcomes: presets.outcomes, clients: [], locale }), presets, clock,
    ai: new IntelligenceService({ calls: store.llmCalls, cache: store.llmCache, clock }),
    execute: async (plan, cfg) => (await simulateFirstRun(plan, cfg, knowledge, { start: START })).snapshot,
  });
  let conv = await agent.start(first, "ar");
  const plan = async () => (await store.plans.get(conv.planId!))!;
  const say = async (text: string) => { conv = (await agent.send(conv.id, text)).conversation; return conv.messages.at(-1)!; };
  return { say, plan, store, conv: () => conv };
}

describe("conversation is the source of truth for the campaign state", () => {
  it("section 14, literally: every message updates the state and the plan the user sees", async () => {
    const { say, plan } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks في الإمارات");
    let p = await plan();
    // No example-campaign defaults: the audience is unknown until the user says it.
    expect(p.state.audience).toMatchObject({ archetype: null, label: null, kind: null });
    expect(p.strategy.signals.map((x) => x.label).join(" ")).not.toMatch(/Meta|وكالة|3\+|تقارير/);
    expect(p.questions.map((q) => q.id)).toContain("audience_pick");

    let m = await say("ميديا بايرز");
    p = await plan();
    expect(p.state.audience).toMatchObject({ archetype: "media_buyers", kind: "people" });
    expect(p.state.audience.label).toContain("Media Buyers");
    expect(m.text).toContain("تم تعديل الجمهور");
    expect(m.cards?.some((c) => c.kind === "plan")).toBe(true); // the plan is shown again, updated

    m = await say("الشركات الكبيرة");
    p = await plan();
    expect(p.state.audience.archetype).toBe("media_buyers"); // still media buyers — size narrows, it doesn't replace
    expect(p.state.companySize).toMatchObject({ min: 250, max: null });
    expect(m.text).toContain("الشركات الكبيرة");

    await say("دبي");
    p = await plan();
    expect(p.state.geography).toMatchObject({ countries: ["AE"], cities: ["Dubai"] });

    m = await say("استخدم البريد فقط");
    expect((await plan()).state.channels).toEqual(["email"]);
    expect(m.text).toContain("فقط");

    await say("خل الرسائل بالعربي");
    expect((await plan()).state.language).toBe("ar");

    m = await say("اعتمد كل الرسائل اللي فوق 85");
    expect((await plan()).state.approval).toEqual({ mode: "auto", autoAbove: 85 });
    expect(m.text).toContain("85+");

    // Every step is in the change log, in order, with what caused it.
    const log = (await plan()).changeLog.filter((e) => e.source !== "initial").map((e) => e.field);
    expect(log).toEqual(expect.arrayContaining(["audience", "size", "market", "channels", "language", "approval"]));
    expect(log.indexOf("audience")).toBeLessThan(log.indexOf("size"));
    expect((await plan()).changeLog.find((e) => e.field === "audience" && e.source !== "initial")).toMatchObject({ from: "غير محدد" });
  });

  it("section 15: people → companies replaces titles with company types, nothing mixed", async () => {
    const { say, plan } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks في الإمارات");
    await say("خلهم ميديا بايرز");
    let p = await plan();
    expect(p.state.audience.kind).toBe("people");
    expect(p.draft.audience.requireTitle).toBe(true);
    expect(p.state.audience.titles).toContain("Media Buyer");

    const m = await say("لا، خلهم شركات ميديا باينغ");
    p = await plan();
    expect(p.state.audience).toMatchObject({ archetype: "media_buying_companies", kind: "companies" });
    expect(p.draft.audience.requireTitle).toBe(false);
    expect(p.state.audience.titles).not.toContain("Media Buyer");
    expect(p.draft.audience.companyTypes).toEqual(["Media buying agency"]);
    expect(m.text).toContain("تقصد");
    expect(m.text).toContain("وليس");
    expect(p.questions.map((q) => q.id)).not.toContain("media_kind");
  });

  it("a new audience replaces the old one; it's added only when the user says so", async () => {
    const { say, plan } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks من وكالات التسويق في الإمارات");
    expect((await plan()).state.audience.archetype).toBe("marketing_agencies");
    await say("ميديا بايرز");
    let p = await plan();
    expect(p.state.audience.archetype).toBe("media_buyers");
    expect(p.state.audience.label).not.toContain("وكالات");
    await say("أضف وكالات التسويق مع ميديا بايرز");
    p = await plan();
    expect(p.state.audience.label).toContain("Media Buyers");
    expect(p.state.audience.label).toContain("وكالات");
  });

  it("section 13: switching the core audience to another domain asks first; a correction doesn't", async () => {
    const { say, plan } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks من وكالات التسويق في الإمارات");
    const m = await say("بدل الوكالات، استهدف شركات العقار");
    expect(m.text).toContain("هذا يغيّر الجمهور الأساسي");
    expect((await plan()).state.audience.archetype).toBe("marketing_agencies"); // not yet
    await say("نعم");
    expect((await plan()).state.audience.archetype).toBe("real_estate_companies");
    await say("لا، استهدف ميديا بايرز");
    expect((await plan()).state.audience.archetype).toBe("media_buyers");
  });

  it("the approval rule set in chat applies when the messages are drafted", async () => {
    const { say, store, conv } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks من وكالات التسويق في الإمارات");
    await say("اعتمد كل الرسائل اللي فوق 85");
    await say("ابدأ البحث");
    const run = (await store.runs.get(conv().campaignId!))!;
    expect(run.reviewPolicy).toEqual({ mode: "auto", autoAbove: 85 });
    expect(run.review.filter((i) => i.status === "approved").every((i) => (i.score ?? 0) >= 85)).toBe(true);
  });

  it("won't start without knowing who to target", async () => {
    const { say, store, conv } = await chat("أبغى 100 عميل مدفوع لـ DataSpeaks في الإمارات");
    const m = await say("ابدأ البحث");
    expect(m.text).toContain("من نستهدف");
    expect(conv().campaignId).toBeUndefined();
    expect(await store.runs.find(() => true)).toHaveLength(0);
  });
});
