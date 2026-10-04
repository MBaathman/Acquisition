import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcquisitionAgent, IntelligenceService, ManualClock, createMemoryStore, reviewCounts, simulateFirstRun, type BuilderPresets, type Knowledge } from "../src/index.js";
import { START } from "./helpers.js";

const root = join(import.meta.dirname, "..", "presets");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const presets: BuilderPresets = { outcomes: read("outcomes.json").presets, intents: read("replies.json").intents };
const knowledge: Knowledge = read("knowledge.json");

async function running(sentence = "أبغى 100 عميل مدفوع لـDataSpeaks في الإمارات من وكالات التسويق") {
  const store = createMemoryStore();
  const clock = new ManualClock(START);
  const agent = new AcquisitionAgent({
    conversations: store.conversations, plans: store.plans, runs: store.runs, approvals: store.approvals,
    planner: (locale) => ({ knowledge, outcomes: presets.outcomes, clients: [], locale }), presets, clock,
    ai: new IntelligenceService({ calls: store.llmCalls, cache: store.llmCache, clock }),
    execute: async (plan, cfg) => (await simulateFirstRun(plan, cfg, knowledge, { start: START })).snapshot,
  });
  let conv = await agent.start(sentence, "ar");
  conv = (await agent.send(conv.id, "ابدأ البحث")).conversation;
  const say = async (text: string, reviewItemId?: string) => {
    conv = (await agent.send(conv.id, text, { reviewItemId })).conversation;
    return conv.messages.at(-1)!.text;
  };
  const run = async () => (await store.runs.get(conv.campaignId!))!;
  return { agent, store, say, run, last: () => conv.messages.at(-1)!.text };
}

describe("agent workspace — review and approve in place", () => {
  it("lands on the actual work: every drafted message with why, sources and status", async () => {
    const { run, last } = await running();
    const r = await run();
    const rc = reviewCounts(r.review);
    expect(rc.total).toBeGreaterThan(10);
    expect(last()).toContain("خلصت البحث والتخصيص");
    expect(last()).toContain("ما أرسلت أي شيء");
    expect(r.counts.messagesReady).toBe(rc.pending);
    const item = r.review[0]!;
    expect(item.reasons.length).toBeGreaterThan(0);
    expect(item.reasons.every((x) => x.source)).toBe(true); // every stated reason has a source
    expect(item.body).toContain(item.style.language === "ar" ? item.firstNameAr ?? item.firstName : item.firstName);
    expect(r.review.filter((i) => i.flags.length).every((i) => i.status === "needs_edit")).toBe(true);
  });

  it("the spec's example: shorter & more direct → approve 85+ → exclude Dubai", async () => {
    const { say, run } = await running();
    const before = await run();
    const total = reviewCounts(before.review).total;

    expect(await say("خل الرسائل أقصر وأكثر مباشرة")).toContain(`عدّلت`);
    expect((await run()).review.filter((i) => i.status !== "excluded").every((i) => i.style.short && i.style.direct)).toBe(true);

    const high = (await run()).review.filter((i) => i.status === "ready" && (i.score ?? 0) >= 85).length;
    const reply = await say("اعتمد الرسائل اللي تقييمها فوق 85");
    expect(reply).toContain("بدرجة 85+");
    expect(reviewCounts((await run()).review).approved).toBe(high);
    expect(reply).toMatch(/بقيت .* تحتاج مراجعة/);

    const dubai = (await run()).review.filter((i) => i.city === "Dubai" && i.status !== "excluded").length;
    const ex = await say("استبعد شركات دبي");
    expect(reviewCounts((await run()).review).excluded).toBe(dubai);
    expect(ex).toContain("استبعدت");
    expect(reviewCounts((await run()).review).total).toBe(total);
  });

  it("rewrites one message from its card and waits for the edit to be accepted", async () => {
    const { say, run, agent } = await running();
    const item = (await run()).review[0]!;
    const reply = await say("خلها أكثر مباشرة واذكر التقارير", item.id);
    expect(reply).toContain(item.company);
    const after = (await run()).review.find((i) => i.id === item.id)!;
    expect(after.pendingEdit?.body).toBeTruthy();
    expect(after.body).toBe(item.body); // unchanged until accepted
    await agent.reviewAction(after.id.length ? (await run()).id : "", "accept_edit", [item.id]);
    const accepted = (await run()).review.find((i) => i.id === item.id)!;
    expect(accepted.body).not.toBe(item.body);
    expect(accepted.style.direct).toBe(true);
  });

  it("never states what has no source", async () => {
    const { say, run } = await running();
    await say("خل كل الرسائل تذكر الميزانية");
    const r = await run();
    expect(r.review.every((i) => !i.body.includes("ميزانية"))).toBe(true);
  });

  it("asks what to change when only the target is given, then applies it", async () => {
    const { say, run } = await running();
    const name = (await run()).review.find((i) => i.firstNameAr === "سارة")?.firstNameAr;
    if (!name) return; // fixture may not include one
    expect(await say("عدّل رسالة سارة فقط")).toContain("وش تبي أعدل");
    await say("خلها أقصر");
    const saras = (await run()).review.filter((i) => i.firstNameAr === "سارة");
    expect(saras.every((i) => i.style.short || i.pendingEdit?.style.short)).toBe(true);
  });

  it("approval policy by chat; approve-all leaves the flagged ones; buttons work without chat", async () => {
    const { say, run, agent } = await running();
    const r0 = await run();
    const clean90 = r0.review.filter((i) => i.status === "ready" && (i.score ?? 0) >= 90).length;
    expect(await say("اعتمد تلقائياً الرسائل التي تتجاوز 90")).toContain(`90+`);
    expect(reviewCounts((await run()).review).approved).toBe(clean90);
    expect((await run()).reviewPolicy).toEqual({ mode: "auto", autoAbove: 90 });

    const flagged = reviewCounts((await run()).review).needsEdit;
    const all = await say("اعتمد الكل");
    if (flagged) expect(all).toContain("تحفظ");
    expect(reviewCounts((await run()).review).ready).toBe(0);

    const one = (await run()).review.find((i) => i.status === "needs_edit");
    if (one) {
      await agent.reviewAction((await run()).id, "exclude", [one.id]);
      expect((await run()).review.find((i) => i.id === one.id)!.status).toBe("excluded");
      await agent.reviewAction((await run()).id, "restore", [one.id]);
      expect((await run()).review.find((i) => i.id === one.id)!.status).toBe("needs_edit");
    }
    expect(await say("خلني أوافق على كل رسالة")).toContain("يدوية");
  });
});
