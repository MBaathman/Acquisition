import type { Clock } from "../adapters/ports.js";
import { buildCampaignConfig, type BuilderPresets, type Locale } from "../config/builder.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Collection } from "../store/store.js";
import { newId } from "../runtime/ids.js";
import { interpretMessage } from "../intelligence/prompts.js";
import type { IntelligenceService } from "../intelligence/service.js";
import { parseMessage, sanitizeIntents, type AgentIntent, type QueryTopic } from "./intents.js";
import { applyAnswer, applyChanges, buildPlan, countOf, diffPlans, planSteps, type CampaignPlan, type PlanChanges, type PlannerContext, type PlanQuestion } from "./planner.js";
import { understandRequest } from "./plans.js";
import type { CampaignSnapshot } from "./snapshot.js";
import { acceptEdit, autoApprove, buildReview, reviewCounts, rewriteItems, selectItems, type OfferText, type ReviewFilter, type ReviewItem, type ReviewPolicy } from "./review.js";

/**
 * The acquisition agent. The user talks; the agent turns each message into
 * structured intents, acts on stored data (plan, campaign run, approvals) and
 * replies with text plus structured cards the UI renders. It decides routine
 * work itself (AUTO), asks only when a detail really matters (ASK), and puts
 * external or strategic actions in front of a human (APPROVAL).
 *
 * Nothing here calls a model unless the rules could not understand a message;
 * replies are composed from the stored plan and campaign data.
 */

// ---------------------------------------------------------------------------
// Data model

export interface RunCounts {
  discovered: number;
  researched: number;
  fit: number;
  excluded: number;
  contactsFound: number;
  needsContact: number;
  messagesReady: number;
  needsReview: number;
  unsourcedDiscarded: number;
  outcomes: number;
}

export interface ActivityItem {
  at: string;
  text: string;
  kind: "info" | "done" | "needs_you";
}

export interface CampaignRun {
  /** The campaign id. */
  id: string;
  clientId: string;
  clientName: string;
  planId: string;
  conversationId: string;
  status: "running" | "paused";
  cfg: CampaignConfig;
  counts: RunCounts;
  snapshot: CampaignSnapshot;
  activity: ActivityItem[];
  /** The drafted messages under review — the agent workspace's work list. */
  review: ReviewItem[];
  reviewPolicy: ReviewPolicy;
  launchedAt: string;
  updatedAt: string;
}

/** A button press on the review list (no chat needed). */
export type ReviewAction = "approve" | "exclude" | "restore" | "accept_edit" | "discard_edit";

export interface AgentApproval {
  id: string;
  campaignId: string;
  conversationId: string;
  kind: "plan_change";
  title: string;
  rows: { key: string; label: string; from: string; to: string }[];
  changes: PlanChanges;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
}

export interface ProspectItem {
  id: string;
  name: string;
  sub: string;
  score: number | null;
  max: number | null;
  reasons: string[];
}

/** A button: says something on the user's behalf, opens a page, or opens the plan editor (the chat composer in edit mode). */
export type AgentAction = { label: string; say?: string; route?: "review" | "approvals" | "prospects" | "plan" | "overview" | "research"; edit?: boolean; primary?: boolean };

export type AgentCard =
  | { kind: "text"; text: string }
  | { kind: "plan" }
  | { kind: "assumptions" }
  | { kind: "questions"; questions: PlanQuestion[] }
  | { kind: "diff"; rows: AgentApproval["rows"]; notes: string[]; approvalId?: string }
  | { kind: "status"; counts: RunCounts; status: CampaignRun["status"] | "draft" }
  | { kind: "progress"; steps: { title: string; detail: string }[] }
  | { kind: "prospects"; title: string; items: ProspectItem[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "actions"; actions: AgentAction[] };

export interface ConversationMessage {
  id: string;
  role: "user" | "agent";
  at: string;
  text: string;
  intents?: AgentIntent[];
  /** Written from one review item's own composer. */
  target?: { id: string; label: string };
  understoodBy?: "rules" | "llm";
  cards?: AgentCard[];
}

export interface Conversation {
  id: string;
  locale: Locale;
  planId?: string;
  campaignId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  /** A change to a running campaign waiting for yes/no. */
  pendingApprovalId?: string;
  /** Messages the user picked for a rewrite before saying how ("عدّل رسالة سارة" → next message says what). */
  reviewScope?: ReviewFilter;
}

/** Read-only view of a campaign created outside a conversation (advanced setup, demo data). */
export interface CampaignView {
  name: string;
  clientName: string;
  outcomeLabel: string;
  outcomePlural: string;
  goal?: number;
  status: string;
  snapshot: SnapshotLike;
}

export interface AgentDeps {
  conversations: Collection<Conversation>;
  plans: Collection<CampaignPlan>;
  runs: Collection<CampaignRun>;
  approvals: Collection<AgentApproval>;
  planner: (locale: Locale) => PlannerContext;
  presets: BuilderPresets;
  clock: Clock;
  ai?: IntelligenceService;
  /** Runs the engine for a campaign and returns its state (simulation in the prototype, the real engine on the server). */
  execute: (plan: CampaignPlan, cfg: CampaignConfig) => Promise<CampaignSnapshot>;
  campaignView?: (campaignId: string) => Promise<CampaignView | undefined>;
  onCampaignStarted?: (run: CampaignRun, plan: CampaignPlan) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Counting and activity (derived from stored engine data — no model)

type SnapshotLike = Pick<CampaignSnapshot, "prospects" | "outreach"> & { outcomes?: { counted?: boolean }[] };

export function countsOf(s: SnapshotLike): RunCounts {
  const P = s.prospects;
  const fit = P.filter((p) => p.milestones?.fit).length;
  return {
    discovered: P.length,
    researched: P.filter((p) => p.milestones?.researched).length,
    fit,
    excluded: P.length - fit,
    contactsFound: P.filter((p) => p.milestones?.fit && p.contactStatus === "found").length,
    needsContact: P.filter((p) => p.contactStatus === "not_found" || p.contactStatus === "needs_contact").length,
    messagesReady: s.outreach.filter((a) => a.status === "pending_approval" && (a.type === "send_message" || a.type === "follow_up")).length,
    needsReview: P.filter((p) => p.researchStatus === "needs_review").length,
    unsourcedDiscarded: P.reduce((n, p) => n + (p.rejected?.length ?? 0), 0),
    outcomes: (s.outcomes ?? []).filter((o) => o.counted).length,
  };
}

const L = (loc: Locale, ar: string, en: string) => (loc === "ar" ? ar : en);
/** "رسالة واحدة / 5 رسائل / 21 رسالة" — Arabic number agreement for the nouns the agent reports. */
const msgs = (loc: Locale, n: number) => (loc === "ar" ? (n === 1 ? "رسالة واحدة" : countOf("ar", n, "رسالة", "رسائل")) : `${n} message${n === 1 ? "" : "s"}`);
const orgs = (loc: Locale, n: number) => (loc === "ar" ? countOf("ar", n, "جهة", "جهات") : `${n} prospect${n === 1 ? "" : "s"}`);

export function activityFor(plan: CampaignPlan, k: RunCounts, at: string): ActivityItem[] {
  const loc = plan.locale;
  const u = plan.understanding;
  const items: [string, ActivityItem["kind"]][] = [
    [L(loc, `بدأت أبحث عن ${u.audience.label} في ${u.market.place}.`, `Started looking for ${u.audience.label} in ${u.market.place}.`), "info"],
    [L(loc, `وجدت ${orgs(loc, k.discovered)} محتملة.`, `Found ${k.discovered} potential prospects.`), "done"],
    [L(loc, `درست ${k.researched} منها مع ذكر المصدر${k.unsourcedDiscarded ? `، واستبعدت ${k.unsourcedDiscarded} معلومة بلا مصدر` : ""}.`, `Researched ${k.researched} with sources${k.unsourcedDiscarded ? `; discarded ${k.unsourcedDiscarded} unsourced facts` : ""}.`), "done"],
    [L(loc, `استبعدت ${orgs(loc, k.excluded)} لأنها لا تطابق معاييرك.`, `Excluded ${k.excluded} that don't match your criteria.`), "info"],
    [L(loc, `وجدت ${k.contactsFound} جهة اتصال مناسبة.`, `Found ${k.contactsFound} suitable contacts.`), "done"],
    [L(loc, `جهزت ${msgs(loc, k.messagesReady)} للمراجعة.`, `Drafted ${k.messagesReady} messages for review.`), "done"],
  ];
  if (k.messagesReady) items.push([L(loc, "أحتاج موافقتك قبل الإرسال.", "I need your approval before sending."), "needs_you"]);
  return items.map(([text, kind]) => ({ at, text, kind }));
}

function topProspects(s: SnapshotLike, n: number): ProspectItem[] {
  return s.prospects
    .filter((p) => p.milestones?.fit)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, n)
    .map((p) => ({
      id: p.id,
      name: p.company ?? p.contact,
      sub: [p.contact && p.company ? p.contact : "", p.title, p.city].filter(Boolean).join(" · "),
      score: p.score ?? null,
      max: p.scoreMax ?? null,
      reasons: (p.breakdown ?? []).filter((b) => b.category === "fit" && b.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 3).map((b) => b.label),
    }));
}

// ---------------------------------------------------------------------------
// The agent

/** A reply is an ordered list of blocks: text and cards interleave exactly as composed. */
class Reply {
  cards: AgentCard[] = [];
  say(...lines: string[]) {
    const text = lines.filter(Boolean).join("\n");
    if (!text) return this;
    const last = this.cards.at(-1);
    if (last?.kind === "text") last.text += `\n${text}`;
    else this.cards.push({ kind: "text", text });
    return this;
  }
  card(c: AgentCard) { this.cards.push(c); return this; }
  get text() { return this.cards.filter((c): c is Extract<AgentCard, { kind: "text" }> => c.kind === "text").map((c) => c.text); }
}

const MATERIAL = new Set(["market", "goal", "size", "minClients", "dm", "threshold"]);
const LOOSER = (from: string, to: string) => ["human_approval", "assisted", "autonomous"].indexOf(to) > ["human_approval", "assisted", "autonomous"].indexOf(from);

export class AcquisitionAgent {
  constructor(private readonly deps: AgentDeps) {}

  private now() {
    return this.deps.clock.now().toISOString();
  }

  /** A new conversation from one sentence. */
  async start(text: string, locale: Locale): Promise<Conversation> {
    const conv: Conversation = { id: newId("conv"), locale, title: text.slice(0, 80), createdAt: this.now(), updatedAt: this.now(), messages: [] };
    await this.deps.conversations.put(conv);
    return (await this.send(conv.id, text)).conversation;
  }

  /** The conversation behind a campaign (created on first open for campaigns set up elsewhere). */
  async forCampaign(campaignId: string, locale: Locale): Promise<Conversation | undefined> {
    const existing = await this.deps.conversations.findOne((c) => c.campaignId === campaignId);
    if (existing) return existing;
    const view = await this.deps.campaignView?.(campaignId);
    if (!view) return undefined;
    const k = countsOf(view.snapshot);
    const conv: Conversation = { id: newId("conv"), locale, campaignId, title: view.name, createdAt: this.now(), updatedAt: this.now(), messages: [] };
    conv.messages.push({
      id: newId("msg"), role: "agent", at: this.now(),
      text: L(locale, `هذه حملة «${view.name}» لـ${view.clientName}. هدفها ${view.goal ? countOf("ar", view.goal, view.outcomeLabel, view.outcomePlural) : "—"}. اسألني عنها: وش لقيت؟ أفضل الفرص؟ ليش اخترت هذي الجهات؟`, `This is “${view.name}” for ${view.clientName}, aiming for ${view.goal ?? "—"} ${view.outcomePlural}. Ask me about it: what did you find? best opportunities? why these prospects?`),
      cards: [{ kind: "status", counts: k, status: view.status === "paused" ? "paused" : "running" }, { kind: "actions", actions: this.suggestions(locale, true) }],
    });
    await this.deps.conversations.put(conv);
    return conv;
  }

  /** Handles one user message. Returns the conversation to show (a new one when the user starts a different goal). */
  async send(conversationId: string, text: string, opts: { reviewItemId?: string } = {}): Promise<{ conversation: Conversation }> {
    let conv = await this.require(conversationId);
    const userMsg: ConversationMessage = { id: newId("msg"), role: "user", at: this.now(), text };
    if (opts.reviewItemId && conv.campaignId) {
      const item = (await this.deps.runs.get(conv.campaignId))?.review.find((i) => i.id === opts.reviewItemId);
      if (item) userMsg.target = { id: item.id, label: item.company };
    }
    conv.messages.push(userMsg);
    await this.deps.conversations.put(conv);
    const loc = conv.locale;
    const planner = this.deps.planner(loc);
    let plan = conv.planId ? await this.deps.plans.get(conv.planId) : undefined;
    const run = conv.campaignId ? await this.deps.runs.get(conv.campaignId) : undefined;
    const view = !plan && conv.campaignId ? await this.deps.campaignView?.(conv.campaignId) : undefined;

    const { intents, understoodBy } = await this.interpret(text, conv, planner, plan, Boolean(run || view), run, userMsg.target?.id);
    userMsg.intents = intents;
    userMsg.understoodBy = understoodBy;
    await this.deps.conversations.put(conv);

    // A different goal starts its own conversation.
    const goal = intents.find((i): i is Extract<AgentIntent, { type: "new_goal" }> => i.type === "new_goal");
    if (goal && (plan || run || view)) {
      await this.reply(conv, new Reply().say(L(loc, "هذا هدف جديد — فتحت له محادثة مستقلة.", "That's a new goal — I opened a separate conversation for it.")));
      return { conversation: await this.start(goal.request, loc) };
    }

    const r = new Reply();
    if (goal) {
      plan = await this.createPlan(conv, goal.request, planner, r);
    } else {
      for (const intent of intents) {
        plan = conv.planId ? await this.deps.plans.get(conv.planId) : plan;
        const current = conv.campaignId ? await this.deps.runs.get(conv.campaignId) : undefined;
        await this.handle(intent, conv, r, planner, plan, current, view);
        conv = (await this.deps.conversations.get(conv.id)) ?? conv;
      }
    }
    await this.reply(conv, r);
    return { conversation: (await this.deps.conversations.get(conv.id))! };
  }

  /** Approve or reject a pending plan change (from the chat or the approvals page). */
  async decide(approvalId: string, approve: boolean): Promise<Conversation> {
    const a = await this.deps.approvals.get(approvalId);
    if (!a) throw new Error(`approval ${approvalId} not found`);
    const conv = await this.require(a.conversationId);
    const r = new Reply();
    if (a.status !== "pending") {
      r.say(L(conv.locale, "تم البت في هذا التعديل سابقاً.", "That change was already decided."));
    } else if (!approve) {
      await this.deps.approvals.put({ ...a, status: "rejected", decidedAt: this.now() });
      r.say(L(conv.locale, "ألغيت التعديل — الخطة كما هي.", "Change dropped — the plan stays as it was."));
    } else {
      await this.deps.approvals.put({ ...a, status: "approved", decidedAt: this.now() });
      const run = await this.deps.runs.get(a.campaignId);
      const plan = conv.planId ? await this.deps.plans.get(conv.planId) : undefined;
      if (run && plan) {
        const next = { ...applyChanges(plan, a.changes, this.deps.planner(conv.locale)), status: "approved" as const };
        await this.deps.plans.put(next);
        const updated = await this.rerun(run, next, L(conv.locale, `طبّقت التعديل المعتمد: ${a.title}.`, `Applied the approved change: ${a.title}.`));
        r.say(L(conv.locale, "اعتمدت التعديل وأعدت حساب الخطة.", "Change approved — I recalculated the plan."));
        r.card({ kind: "diff", rows: a.rows, notes: next.notes });
        r.say(this.statusLine(conv.locale, updated.counts));
        r.card({ kind: "status", counts: updated.counts, status: updated.status });
      }
    }
    conv.pendingApprovalId = undefined;
    await this.deps.conversations.put(conv);
    await this.reply(conv, r);
    return (await this.deps.conversations.get(conv.id))!;
  }

  // -------------------------------------------------------------------------

  private async interpret(text: string, conv: Conversation, planner: PlannerContext, plan: CampaignPlan | undefined, running: boolean, run?: CampaignRun, target?: string) {
    const names = (run?.review ?? []).flatMap((i) => [i.company, i.company.split(" ")[0] ?? "", i.person, i.firstName, i.firstNameAr ?? ""]).filter((n) => n.length >= 3);
    const ctx = { planner, plan, running, pending: Boolean(conv.pendingApprovalId), review: run?.review.length ? { names: [...new Set(names)] } : undefined, target };
    const rules = parseMessage(text, ctx);
    const ai = this.deps.ai;
    const input = {
      message: text,
      locale: conv.locale,
      plan: plan ? { goal: plan.understanding.outcome.goal, outcome: plan.understanding.outcome.preset, market: plan.understanding.market.countries.join(","), audience: plan.understanding.audience.archetype, channels: plan.strategy.channelKeys, threshold: plan.strategy.threshold, maxScore: plan.strategy.maxScore } : null,
      openQuestions: (plan?.questions ?? []).map((q) => ({ id: q.id, text: q.text, options: q.options.map((o) => ({ id: o.id, label: o.label })) })),
      regions: planner.knowledge.regions.map((r) => ({ code: r.code, cities: r.cities.map((c) => c.key) })),
      running,
    };
    if (!ai || rules[0]?.type !== "unknown" || !ai.hasProvider) {
      if (ai && rules[0]?.type !== "new_goal") await ai.skipped(interpretMessage, input, { campaignId: conv.campaignId });
      return { intents: rules, understoodBy: "rules" as const };
    }
    const res = await ai.run(interpretMessage, input, { scope: { campaignId: conv.campaignId }, fallback: () => ({ intents: [] }) });
    const intents: AgentIntent[] = res.output.intents.map((i) => {
      const c = i.changes;
      switch (i.type) {
        case "update_plan":
          return { type: "update_plan", changes: c ? {
            countries: c.countries ?? undefined, cities: c.cities ?? undefined, goal: c.goal ?? undefined,
            sizeMin: c.sizeMin ?? undefined, sizeMax: c.sizeMax ?? undefined, minClients: c.minClients ?? undefined,
            channels: c.email !== null || c.linkedin !== null ? { email: c.email ?? undefined, linkedin: c.linkedin ?? undefined } : undefined,
            language: c.language ?? undefined, threshold: c.threshold ?? undefined, decisionMakersOnly: c.decisionMakersOnly ?? undefined, autonomy: c.autonomy ?? undefined,
          } : {} };
        case "answer": return { type: "answer", questionId: i.questionId ?? "", value: i.value ?? "" };
        case "query": return { type: "query", topic: (i.topic ?? "help") as QueryTopic };
        case "new_goal": return { type: "new_goal", request: text };
        default: return { type: i.type } as AgentIntent;
      }
    });
    const clean = sanitizeIntents(intents.length ? intents : [{ type: "unknown" }], ctx);
    return { intents: clean, understoodBy: res.source === "rules" ? ("rules" as const) : ("llm" as const) };
  }

  private async createPlan(conv: Conversation, request: string, planner: PlannerContext, r: Reply): Promise<CampaignPlan> {
    const loc = conv.locale;
    const { extraction, understoodBy } = await understandRequest(request, planner, this.deps.ai);
    let plan = buildPlan(extraction, planner, { request, createdAt: this.now(), understoodBy });
    plan.id = newId("plan");
    // Anything else the sentence already said (language, channels, approval policy...) is applied, not asked again.
    const extra = parseMessage(request, { planner, plan }).find((i): i is Extract<AgentIntent, { type: "update_plan" }> => i.type === "update_plan");
    if (extra) {
      const { countries: _c, cities: _ci, goal: _g, ...rest } = extra.changes;
      if (Object.keys(rest).length) plan = applyChanges(plan, rest, planner);
    }
    await this.deps.plans.put(plan);
    conv.planId = plan.id;
    const goalText = countOf(loc, plan.understanding.outcome.goal, plan.understanding.outcome.label, plan.understanding.outcome.plural);
    conv.title = `${plan.understanding.client.name} · ${goalText}`;
    await this.deps.conversations.put(conv);

    const u = plan.understanding;
    const arch = planner.knowledge.archetypes.find((a) => a.key === u.audience.archetype);
    const bullets = [u.audience.label, u.market.place, ...(arch?.assumptions[loc] ?? []).slice(0, 2)];
    r.say(
      L(loc, "فهمتك.", "Got it."),
      L(loc, `هدفك: ${goalText} لـ${u.client.name}`, `Your goal: ${goalText} for ${u.client.name}`),
      L(loc, "سأستهدف مبدئياً:", "To start, I'll target:"),
      ...bullets.map((b) => `• ${b}`),
      arch?.targetType === "individual"
        ? L(loc, "وسأبحث عن المهتمين فعلاً وأبني قائمة العملاء المحتملين.", "I'll look for people with real interest and build the prospect list.")
        : L(loc, "وسأبحث عن أصحاب القرار وأبني قائمة العملاء المحتملين.", "I'll find the decision makers and build the prospect list."),
    );
    this.nextStep(plan, r);
    r.card({ kind: "plan" });
    r.card({ kind: "assumptions" });
    return plan;
  }

  /** Ask what still matters, or offer to start. */
  private nextStep(plan: CampaignPlan, r: Reply) {
    const loc = plan.locale;
    if (plan.questions.length) {
      r.say(plan.questions.length === 1
        ? L(loc, "قبل أن أبدأ، عندي نقطة واحدة أحتاج تأكيدها:", "Before I start, one thing to confirm:")
        : L(loc, "قبل أن أبدأ، عندي نقطتان أحتاج تأكيدهما:", "Before I start, two things to confirm:"));
      r.card({ kind: "questions", questions: plan.questions });
    } else {
      r.say(L(loc, "الخطة جاهزة. أبدأ البحث؟", "The plan is ready. Shall I start?"));
      r.card({ kind: "actions", actions: [
        { label: L(loc, "ابدأ البحث", "Start"), say: L(loc, "ابدأ البحث", "Start"), primary: true },
        { label: L(loc, "عدّل الخطة", "Change the plan"), edit: true },
      ] });
    }
  }

  private async handle(intent: AgentIntent, conv: Conversation, r: Reply, planner: PlannerContext, plan: CampaignPlan | undefined, run: CampaignRun | undefined, view: CampaignView | undefined): Promise<void> {
    const loc = conv.locale;
    switch (intent.type) {
      case "answer": {
        if (!plan) return;
        const q = plan.questions.find((x) => x.id === intent.questionId);
        const next = applyAnswer(plan, intent.questionId, intent.value, planner);
        const rows = diffPlans(plan, next);
        await this.deps.plans.put(run ? { ...next, status: "approved" } : next);
        const label = q?.options.find((o) => o.id === intent.value)?.label ?? intent.value;
        r.say(L(loc, `تمام — ${label}.`, `Done — ${label}.`));
        if (rows.length) r.card({ kind: "diff", rows, notes: next.notes });
        if (!run) this.nextStep(next, r);
        return;
      }
      case "update_plan": {
        if (!plan) {
          r.say(L(loc, "هذه الحملة أُعدّت من الإعدادات المتقدمة، لذا تعديلها من هناك. ابدأ هدفاً جديداً بجملة واحدة لتديره بالمحادثة.", "This campaign was configured in advanced settings, so change it there. Start a new goal in one sentence to run it by conversation."));
          return;
        }
        const next = applyChanges(plan, intent.changes, planner);
        const rows = diffPlans(plan, next);
        if (!rows.length) {
          r.say(intent.changes.autonomy === "human_approval"
            ? L(loc, "هذا هو الإعداد الحالي أصلاً: لا يُرسل أي شيء قبل موافقتك.", "That's already the setting: nothing is sent before you approve.")
            : L(loc, "هذا مطبّق في الخطة أصلاً.", "The plan already does that."));
          return;
        }
        const material = rows.some((x) => MATERIAL.has(x.key)) || (rows.some((x) => x.key === "autonomy") && LOOSER(plan.strategy.autonomy, next.strategy.autonomy));
        if (run && material) {
          const approval: AgentApproval = {
            id: newId("apr"), campaignId: run.id, conversationId: conv.id, kind: "plan_change",
            title: rows.map((x) => L(loc, `${x.label}: ${x.from} ← ${x.to}`, `${x.label}: ${x.from} → ${x.to}`)).join(L(loc, "، ", ", ")),
            rows, changes: intent.changes, status: "pending", createdAt: this.now(),
          };
          await this.deps.approvals.put(approval);
          conv.pendingApprovalId = approval.id;
          await this.deps.conversations.put(conv);
          r.say(L(loc, "هذا تغيير جوهري على حملة تعمل، فيحتاج موافقتك. هذا ما سيتغير:", "That's a major change to a running campaign, so it needs your approval. Here's what changes:"));
          r.card({ kind: "diff", rows, notes: next.notes, approvalId: approval.id });
          r.say(L(loc, "هل أعتمد التعديل وأعيد حساب خطة الاكتساب؟ (موجود أيضاً في «الموافقات»)", "Shall I apply it and recalculate the plan? (Also listed under Approvals.)"));
          return;
        }
        await this.deps.plans.put(run ? { ...next, status: "approved" } : next);
        if (run) {
          const cfg = this.configFor(next, run.id, run.status);
          await this.deps.runs.put({ ...run, cfg, updatedAt: this.now(), activity: [...run.activity, { at: this.now(), text: L(loc, `حدّثت الحملة: ${rows.map((x) => `${x.label} ← ${x.to}`).join("، ")}.`, `Updated the campaign: ${rows.map((x) => `${x.label} → ${x.to}`).join(", ")}.`), kind: "info" }] });
        }
        r.say(L(loc, "تم.", "Done."), L(loc, "عدّلت الخطة إلى:", "I updated the plan:"));
        r.card({ kind: "diff", rows, notes: next.notes });
        if (!run) r.card({ kind: "plan" });
        if (!run && next.questions.length) this.nextStep(next, r);
        else if (!run) r.card({ kind: "actions", actions: [{ label: L(loc, "ابدأ البحث", "Start"), say: L(loc, "ابدأ البحث", "Start"), primary: true }, { label: L(loc, "اعرض الخطة", "Show the plan"), say: L(loc, "وش الخطة؟", "What's the plan?") }] });
        return;
      }
      case "confirm": {
        if (conv.pendingApprovalId) { await this.decide(conv.pendingApprovalId, true); return; }
        if (plan && !run) return this.handle({ type: "start" }, conv, r, planner, plan, run, view);
        r.say(L(loc, "تمام.", "OK."));
        return;
      }
      case "reject": {
        if (conv.pendingApprovalId) { await this.decide(conv.pendingApprovalId, false); return; }
        r.say(L(loc, "تمام، لن أغيّر شيئاً.", "OK, I won't change anything."));
        return;
      }
      case "start":
      case "prepare_outreach": {
        if (run) {
          if (run.status === "paused" && intent.type === "start") return this.handle({ type: "resume" }, conv, r, planner, plan, run, view);
          if (intent.type === "prepare_outreach") {
            r.say(
              L(loc, `الرسائل جاهزة في القائمة: ${msgs(loc, run.counts.messagesReady)} تنتظر مراجعتك.`, `The messages are ready in the list: ${msgs(loc, run.counts.messagesReady)} waiting for your review.`),
              plan ? L(loc, `سياسة الحملة: ${planSteps(plan).find((s) => s.key === "approval")!.text}.`, `Campaign policy: ${planSteps(plan).find((s) => s.key === "approval")!.text}.`) : "",
            );
            r.card({ kind: "actions", actions: [{ label: L(loc, "اعرض القائمة", "Show the list"), route: "review", primary: true }] });
          } else {
            r.say(L(loc, "أعمل عليها بالفعل. هذا الوضع الحالي:", "I'm already on it. Here's where things stand:"));
            r.card({ kind: "status", counts: run.counts, status: run.status });
          }
          return;
        }
        if (view) { r.say(L(loc, "هذه الحملة تعمل بالفعل.", "This campaign is already running.")); r.card({ kind: "status", counts: countsOf(view.snapshot), status: "running" }); return; }
        if (!plan) return;
        await this.launch(conv, plan, planner, r);
        return;
      }
      case "pause":
      case "resume": {
        if (!run) { r.say(L(loc, "لم تبدأ الحملة بعد.", "The campaign hasn't started yet.")); return; }
        const status = intent.type === "pause" ? "paused" : "running";
        if (run.status === status) { r.say(status === "paused" ? L(loc, "الحملة متوقفة أصلاً.", "The campaign is already paused.") : L(loc, "الحملة تعمل أصلاً.", "The campaign is already running.")); return; }
        const cfg = { ...run.cfg, campaign: { ...run.cfg.campaign, status: status === "paused" ? ("paused" as const) : ("active" as const) } };
        const text = status === "paused" ? L(loc, "أوقفت الحملة. لن أتواصل مع أحد حتى تقول «استأنف».", "Campaign paused. I won't contact anyone until you say “resume”.") : L(loc, "استأنفت الحملة.", "Campaign resumed.");
        await this.deps.runs.put({ ...run, status, cfg, updatedAt: this.now(), activity: [...run.activity, { at: this.now(), text, kind: "info" }] });
        r.say(text);
        return;
      }
      case "query":
        return this.answerQuery(intent.topic, conv, r, plan, run, view);
      case "review_approve":
      case "review_exclude":
      case "review_restore":
      case "review_rewrite":
      case "review_policy":
        return this.handleReview(intent, conv, r, plan, run);
      case "new_goal":
        return;
      case "unknown":
        r.say(L(loc, "ما فهمت تماماً. تقدر تقول مثلاً:", "I didn't quite get that. You can say, for example:"));
        r.card({ kind: "actions", actions: this.suggestions(loc, Boolean(run || view)) });
        return;
    }
  }

  private suggestions(loc: Locale, running: boolean): AgentAction[] {
    const s = running
      ? [L(loc, "وش لقيت؟", "What did you find?"), L(loc, "ورني أفضل الفرص", "Show me the best opportunities"), L(loc, "ليش اخترت هذي الجهات؟", "Why these prospects?"), L(loc, "وش يحتاج موافقتي؟", "What needs my approval?")]
      : [L(loc, "ابدأ البحث", "Start"), L(loc, "خلها السعودية", "Make it Saudi Arabia"), L(loc, "استخدم البريد فقط", "Email only"), L(loc, "خل الرسائل بالعربي", "Messages in Arabic")];
    return s.map((x) => ({ label: x, say: x }));
  }

  private statusLine(loc: Locale, k: RunCounts) {
    return L(loc,
      `حالياً: اكتشفت ${k.discovered}، درست ${k.researched}، تأهلت ${k.fit}، ووجدت ${k.contactsFound} جهة اتصال مناسبة. ${msgs(loc, k.messagesReady)} تنتظر موافقتك.`,
      `So far: ${k.discovered} found, ${k.researched} researched, ${k.fit} qualified, ${k.contactsFound} suitable contacts. ${k.messagesReady} messages wait for your approval.`);
  }

  private async answerQuery(topic: QueryTopic, conv: Conversation, r: Reply, plan: CampaignPlan | undefined, run: CampaignRun | undefined, view: CampaignView | undefined) {
    const loc = conv.locale;
    if (topic === "plan") {
      if (plan) { r.say(L(loc, "هذه الخطة الحالية:", "Here's the current plan:")); r.card({ kind: "plan" }); }
      else r.say(L(loc, "هذه الحملة أُعدّت من الإعدادات المتقدمة.", "This campaign was configured in advanced settings."));
      return;
    }
    if (topic === "help") {
      r.say(L(loc, "أنا أدير الحملة نيابة عنك. تقدر تطلب أي شيء بكلامك:", "I run the campaign for you. Ask for anything in your own words:"));
      r.card({ kind: "actions", actions: this.suggestions(loc, Boolean(run || view)) });
      return;
    }
    const snap = run?.snapshot ?? view?.snapshot;
    if (!snap) {
      r.say(L(loc, "لم أبدأ البحث بعد. تبيني أبدأ؟", "I haven't started yet. Shall I?"));
      r.card({ kind: "actions", actions: [{ label: L(loc, "ابدأ البحث", "Start"), say: L(loc, "ابدأ البحث", "Start"), primary: true }] });
      return;
    }
    const k = run?.counts ?? countsOf(snap);
    switch (topic) {
      case "status":
        r.say(this.statusLine(loc, k));
        r.card({ kind: "status", counts: k, status: run?.status ?? "running" });
        return;
      case "results": {
        r.say(L(loc, `هذا ما وجدته: ${orgs(loc, k.discovered)}، ${k.fit} منها تجاوزت حد التأهيل، واستبعدت ${k.excluded} لا تطابق معاييرك.`, `Here's what I found: ${k.discovered} prospects, ${k.fit} passed the qualification bar, ${k.excluded} excluded for not matching your criteria.`));
        r.card({ kind: "prospects", title: L(loc, "أعلى الجهات ملاءمة", "Best fits"), items: topProspects(snap, 5) });
        r.card({ kind: "actions", actions: [{ label: L(loc, "عرض كل الجهات", "See all prospects"), route: "prospects" }, { label: L(loc, "ليش اخترتها؟", "Why these?"), say: L(loc, "ليش اخترت هذي الجهات؟", "Why these prospects?") }] });
        return;
      }
      case "top":
        r.say(L(loc, "أفضل الفرص الآن، مرتبة حسب درجة الملاءمة:", "The best opportunities right now, by fit score:"));
        r.card({ kind: "prospects", title: L(loc, "أفضل الفرص", "Best opportunities"), items: topProspects(snap, 5) });
        return;
      case "explain": {
        const fit = snap.prospects.filter((p) => p.milestones?.fit);
        const reasons = new Map<string, number>();
        for (const p of fit) for (const b of p.breakdown ?? []) if (b.weight > 0) reasons.set(b.label, (reasons.get(b.label) ?? 0) + 1);
        const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const thr = plan ? `${plan.strategy.threshold}/${plan.strategy.maxScore}` : "";
        r.say(L(loc, `اخترت ${fit.length} جهة لأنها تجاوزت حد التأهيل${thr ? ` (${thr})` : ""} بناءً على معلومات موثّقة بمصادرها. أكثر الأسباب تكراراً:`, `I picked ${fit.length} prospects because they passed the qualification bar${thr ? ` (${thr})` : ""} on sourced facts. The most common reasons:`));
        r.card({ kind: "bullets", items: top.map(([label, n]) => L(loc, `${label} — ${n} جهة`, `${label} — ${n} prospects`)) });
        if (k.excluded) r.say(L(loc, `واستبعدت ${k.excluded} لأنها لم تصل للحد أو لم أجد لها مصدراً موثوقاً.`, `I excluded ${k.excluded} that fell short or lacked a reliable source.`));
        return;
      }
      case "approvals": {
        const pendingChanges = run ? await this.deps.approvals.find((a) => a.campaignId === run.id && a.status === "pending") : [];
        r.say(L(loc, `يحتاج موافقتك الآن: ${msgs(loc, k.messagesReady)}${pendingChanges.length ? ` و${pendingChanges.length} تعديل على الخطة` : ""}.`, `Needs your approval now: ${k.messagesReady} messages${pendingChanges.length ? ` and ${pendingChanges.length} plan change(s)` : ""}.`));
        r.card({ kind: "actions", actions: [{ label: L(loc, "اعرض القائمة", "Show the list"), route: "review", primary: true }] });
        return;
      }
      case "activity":
        r.say(L(loc, "آخر ما قمت به:", "What I've been doing:"));
        r.card({ kind: "bullets", items: (run?.activity ?? []).slice(-6).map((a) => a.text) });
        return;
    }
  }

  private configFor(plan: CampaignPlan, campaignId: string, status: CampaignRun["status"] = "running"): CampaignConfig {
    const cfg = buildCampaignConfig({ ...plan.draft, campaign: { ...plan.draft.campaign, id: campaignId, status: "active" } }, this.deps.presets);
    if (status === "paused") cfg.campaign.status = "paused";
    return cfg;
  }

  private async launch(conv: Conversation, plan: CampaignPlan, planner: PlannerContext, r: Reply) {
    const loc = conv.locale;
    // Unanswered questions take their sensible default; say which.
    const assumed: string[] = [];
    for (const q of plan.questions) {
      if (!q.default) continue;
      assumed.push(q.options.find((o) => o.id === q.default)?.label ?? q.default);
      plan = applyAnswer(plan, q.id, q.default, planner);
    }
    let id = plan.draft.campaign.id;
    if (await this.deps.runs.get(id)) id = `${id}-${newId("r").slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const cfg = this.configFor(plan, id);
    const snapshot = await this.deps.execute(plan, cfg);
    const counts = countsOf(snapshot);
    plan = { ...plan, status: "approved", assumptions: plan.assumptions.map((a) => (a.status === "proposed" ? { ...a, status: "accepted" as const } : a)) };
    await this.deps.plans.put(plan);
    const reviewPolicy: ReviewPolicy = { mode: "manual" };
    const review = buildReview(snapshot, this.offerText(plan), plan.strategy.messageLanguage, { now: this.now(), policy: reviewPolicy, reviewLocale: loc, labels: this.signalLabels(plan) });
    const rc = reviewCounts(review);
    counts.messagesReady = rc.pending;
    const run: CampaignRun = {
      id, clientId: plan.understanding.client.id, clientName: plan.understanding.client.name, planId: plan.id, conversationId: conv.id,
      status: "running", cfg, counts, snapshot, activity: activityFor(plan, counts, this.now()), review, reviewPolicy, launchedAt: this.now(), updatedAt: this.now(),
    };
    await this.deps.runs.put(run);
    conv.campaignId = id;
    await this.deps.conversations.put(conv);
    await this.deps.onCampaignStarted?.(run, plan);

    const found = (n: number) => (plan.draft.audience.targetType === "individual" ? L(loc, countOf("ar", n, "شخص", "أشخاص"), `${n} people`) : orgs(loc, n));
    r.say(L(loc, "بدأت.", "Started."));
    if (assumed.length) r.say(L(loc, `افترضت: ${assumed.join("، ")} — قل لي إن أردت غير ذلك.`, `I assumed: ${assumed.join(", ")} — tell me if you want otherwise.`));
    r.card({ kind: "progress", steps: [
      { title: L(loc, "اكتشاف", "Discover"), detail: L(loc, `وجدت ${found(counts.discovered)}`, `Found ${found(counts.discovered)}`) },
      { title: L(loc, "بحث بمصادر", "Research with sources"), detail: L(loc, `درست ${counts.researched}`, `Researched ${counts.researched}`) },
      { title: L(loc, "تقييم", "Score"), detail: L(loc, `${counts.fit} تجاوزت ${plan.strategy.threshold} من ${plan.strategy.maxScore}، واستبعدت ${counts.excluded}`, `${counts.fit} scored ${plan.strategy.threshold}+ of ${plan.strategy.maxScore}; ${counts.excluded} excluded`) },
      { title: L(loc, "جهات الاتصال", "Contacts"), detail: L(loc, `${counts.contactsFound} جهة اتصال مناسبة`, `${counts.contactsFound} suitable contacts`) },
      { title: L(loc, "تخصيص الرسائل", "Personalize"), detail: L(loc, `جهزت ${msgs(loc, rc.total)}`, `Drafted ${rc.total} messages`) },
    ] });
    this.workSummary(loc, r, counts.fit, rc, found);
  }

  /** "خلصت البحث والتخصيص. وجدت 29 جهة مناسبة. جهزت 27 رسالة. في 3 رسائل عندي تحفظ عليها. ما أرسلت أي شيء." */
  private workSummary(loc: Locale, r: Reply, fit: number, rc: ReturnType<typeof reviewCounts>, found: (n: number) => string = (n) => orgs(loc, n)) {
    r.say(
      L(loc, "خلصت البحث والتخصيص.", "Research and personalization are done."),
      L(loc, `وجدت ${found(fit)} مناسبة.`, `I found ${found(fit)} that fit.`),
      L(loc, `جهزت ${msgs(loc, rc.total)}.`, `I drafted ${msgs(loc, rc.total)}.`),
      rc.needsEdit ? L(loc, `في ${msgs(loc, rc.needsEdit)} عندي تحفظ عليها.`, `I have reservations about ${msgs(loc, rc.needsEdit)}.`) : "",
      L(loc, "ما أرسلت أي شيء.", "I haven't sent anything."),
      L(loc, "راجعها هنا تحت، وإذا تبي تغيير عام قل لي وأنا أعدله على المجموعة.", "Review them right below — and if you want a change across the board, just tell me and I'll apply it to the whole set."),
    );
  }

  /** Scoring signal keys (criterion_N, as the builder names them) → label in both languages. */
  private signalLabels(plan: CampaignPlan): Record<string, Record<Locale, string>> {
    return Object.fromEntries(plan.strategy.signals.map((sig, i) => [`criterion_${i + 1}`, sig.labels]));
  }

  /** The offer as message parts in both languages (value, call to action, link). */
  private offerText(plan: CampaignPlan): OfferText {
    const kb = this.deps.planner(plan.locale).knowledge;
    const preset = this.deps.presets.outcomes.find((o) => o.key === plan.understanding.outcome.preset);
    const cta = { ar: preset?.conversion.cta.ar ?? "", en: preset?.conversion.cta.en ?? "" };
    if (plan.extraction.cta) cta[plan.locale] = plan.extraction.cta;
    return { name: plan.draft.offer.name, value: kb.defaults.offer.valueProposition, cta, link: plan.draft.offer.link };
  }

  /** Saves a run after a review change: counts follow the queue; activity records what happened. */
  private async saveReview(run: CampaignRun, note?: string): Promise<CampaignRun> {
    const rc = reviewCounts(run.review);
    const updated: CampaignRun = {
      ...run, counts: { ...run.counts, messagesReady: rc.pending }, updatedAt: this.now(),
      activity: note ? [...run.activity, { at: this.now(), text: note, kind: rc.pending ? "info" : "done" }] : run.activity,
    };
    await this.deps.runs.put(updated);
    return updated;
  }

  /** Buttons on the review list: approve / exclude / restore one or many, accept or discard a single rewrite. */
  async reviewAction(campaignId: string, action: ReviewAction, ids: string[], opts: { announce?: boolean } = {}): Promise<CampaignRun> {
    const run = await this.deps.runs.get(campaignId);
    if (!run) throw new Error(`campaign ${campaignId} not found`);
    const conv = await this.deps.conversations.get(run.conversationId);
    const loc = conv?.locale ?? "ar";
    const now = this.now();
    const items = run.review.filter((i) => ids.includes(i.id));
    for (const i of items) {
      if (action === "approve" && i.status !== "excluded") i.status = "approved";
      if (action === "exclude") i.status = "excluded";
      if (action === "restore" && i.status === "excluded") i.status = i.flags.length ? "needs_edit" : "ready";
      if (action === "accept_edit") acceptEdit(i, now);
      if (action === "discard_edit") i.pendingEdit = undefined;
      i.updatedAt = now;
    }
    const n = items.length;
    const note =
      action === "approve" ? L(loc, `اعتمدت ${msgs(loc, n)}.`, `Approved ${msgs(loc, n)}.`)
      : action === "exclude" ? L(loc, `استبعدت ${orgs(loc, n)}.`, `Excluded ${orgs(loc, n)}.`)
      : action === "restore" ? L(loc, `رجّعت ${orgs(loc, n)} للمراجعة.`, `Restored ${orgs(loc, n)} to review.`)
      : action === "accept_edit" ? L(loc, `اعتمدت تعديل رسالة ${items[0]?.company ?? ""}.`, `Accepted the edit for ${items[0]?.company ?? ""}.`)
      : undefined;
    const updated = await this.saveReview(run, note);
    if (opts.announce && conv && note) {
      const rc = reviewCounts(updated.review);
      const r = new Reply().say(note, this.remaining(loc, rc));
      await this.reply(conv, r);
    }
    return updated;
  }

  private remaining(loc: Locale, rc: ReturnType<typeof reviewCounts>) {
    if (!rc.pending && rc.approved) return L(loc, `✓ ${msgs(loc, rc.approved)} معتمدة — جاهزة للإرسال. ما أرسلت أي شيء (نموذج أولي).`, `✓ ${msgs(loc, rc.approved)} approved — ready to send. Nothing was sent (prototype).`);
    return rc.pending ? L(loc, `بقيت ${msgs(loc, rc.pending)} تحتاج مراجعة.`, `${msgs(loc, rc.pending)} still need review.`) : "";
  }

  private async handleReview(intent: Extract<AgentIntent, { type: `review_${string}` }>, conv: Conversation, r: Reply, plan: CampaignPlan | undefined, run: CampaignRun | undefined) {
    const loc = conv.locale;
    if (!run || !run.review.length) {
      r.say(run ? L(loc, "ما عندي رسائل للمراجعة الآن.", "There are no messages to review right now.") : L(loc, "لم أبدأ بعد — قل «ابدأ البحث» وأجهز الرسائل.", "I haven't started yet — say “start” and I'll draft the messages."));
      return;
    }
    const now = this.now();
    const cityName = (key: string) => this.deps.planner(loc).knowledge.regions.flatMap((x) => x.cities).find((c) => c.key === key)?.name[loc] ?? key;
    const where = (f: ReviewFilter) => [
      f.minScore !== undefined ? L(loc, `بدرجة ${f.minScore}+`, `scoring ${f.minScore}+`) : "",
      f.cities?.length ? L(loc, `في ${f.cities.map(cityName).join("، ")}`, `in ${f.cities.map(cityName).join(", ")}`) : "",
    ].filter(Boolean).join(" ");
    switch (intent.type) {
      case "review_policy": {
        run.reviewPolicy = intent.policy;
        if (intent.policy.mode === "manual") {
          await this.saveReview(run, L(loc, "الموافقة يدوية: كل رسالة تنتظر موافقتك.", "Manual approval: every message waits for you."));
          r.say(L(loc, "تم. الموافقة يدوية — كل رسالة تنتظر موافقتك.", "Done. Approval is manual — every message waits for you."));
          return;
        }
        const n = autoApprove(run.review, intent.policy, now);
        const updated = await this.saveReview(run, L(loc, `اعتماد تلقائي للرسائل بدرجة ${intent.policy.autoAbove}+ بلا تحفظات.`, `Auto-approval for clean messages scoring ${intent.policy.autoAbove}+.`));
        r.say(
          L(loc, `تم. سأعتمد تلقائياً الرسائل بدرجة ${intent.policy.autoAbove}+ اللي ما عندي عليها تحفظ.`, `Done. I'll auto-approve clean messages scoring ${intent.policy.autoAbove}+.`),
          L(loc, `اعتمدت الآن ${msgs(loc, n)}.`, `Approved ${msgs(loc, n)} now.`),
          this.remaining(loc, reviewCounts(updated.review)),
        );
        return;
      }
      case "review_approve": {
        const f = intent.filter;
        const named = Boolean(f.ids?.length || f.names?.length || f.status);
        const scope = { ...f, status: f.status ?? (named ? (["ready", "needs_edit"] as const).slice() : (["ready"] as const).slice()) };
        const items = selectItems(run.review, scope);
        const skipped = named ? 0 : selectItems(run.review, { ...f, status: ["needs_edit"] }).length;
        for (const i of items) { i.status = "approved"; i.updatedAt = now; }
        const updated = await this.saveReview(run, items.length ? L(loc, `اعتمدت ${msgs(loc, items.length)}${where(f) ? ` ${where(f)}` : ""}.`, `Approved ${msgs(loc, items.length)}${where(f) ? ` ${where(f)}` : ""}.`) : undefined);
        if (!items.length) { r.say(L(loc, "ما فيه رسائل جاهزة تطابق هذا.", "No ready messages match that.")); return; }
        r.say(
          L(loc, `اعتمدت ${msgs(loc, items.length)}${where(f) ? ` ${where(f)}` : ""}.`, `Approved ${msgs(loc, items.length)}${where(f) ? ` ${where(f)}` : ""}.`),
          skipped ? L(loc, `تركت ${msgs(loc, skipped)} عندي عليها تحفظ — قل «اعتمد اللي عليها تحفظ» إذا تبيها.`, `I left ${msgs(loc, skipped)} I have reservations about — say “approve the flagged ones” if you want them.`) : "",
          this.remaining(loc, reviewCounts(updated.review)),
        );
        return;
      }
      case "review_exclude":
      case "review_restore": {
        const f = intent.filter;
        if (!f.ids && !f.names && !f.cities && f.minScore === undefined && f.maxScore === undefined && !f.top && !f.large && !f.lacksSignal && !f.status && !f.all) {
          r.say(L(loc, "أي جهات؟ مثلاً: «استبعد شركات دبي» أو «استبعد Oasis».", "Which ones? e.g. “exclude Dubai companies” or “exclude Oasis”."));
          return;
        }
        const restore = intent.type === "review_restore";
        const items = selectItems(run.review, restore ? { ...f, status: ["excluded"] } : f);
        for (const i of items) { i.status = restore ? (i.flags.length ? "needs_edit" : "ready") : "excluded"; i.updatedAt = now; }
        const text = restore ? L(loc, `رجّعت ${orgs(loc, items.length)} للمراجعة.`, `Restored ${orgs(loc, items.length)} to review.`) : L(loc, `استبعدت ${orgs(loc, items.length)}.`, `Excluded ${orgs(loc, items.length)}.`);
        const updated = await this.saveReview(run, items.length ? text : undefined);
        r.say(items.length ? text : L(loc, "ما لقيت جهات تطابق هذا.", "Nothing matches that."), this.remaining(loc, reviewCounts(updated.review)));
        return;
      }
      case "review_rewrite": {
        let f = intent.filter;
        const instruction = intent.rewrite;
        const hasScope = Boolean(f.ids?.length || f.names?.length || f.cities?.length || f.minScore !== undefined || f.top || f.large || f.lacksSignal || f.status);
        if (!Object.keys(instruction).length) {
          const items = selectItems(run.review, f);
          conv.reviewScope = f;
          await this.deps.conversations.put(conv);
          const which = f.ids?.length || (f.names?.length && items.length === 1) ? L(loc, `رسالة ${items[0]?.company ?? ""}`, `the message to ${items[0]?.company ?? ""}`) : msgs(loc, items.length);
          r.say(L(loc, `وش تبي أعدل في ${which}؟ مثلاً: أقصر، أكثر مباشرة، بالعربي، اذكر التقارير، لا تذكر Meta.`, `What should I change in ${which}? e.g. shorter, more direct, in Arabic, mention reporting, don't mention Meta.`));
          return;
        }
        if (!hasScope && conv.reviewScope) { f = conv.reviewScope; conv.reviewScope = undefined; await this.deps.conversations.put(conv); }
        const targets = selectItems(run.review, f);
        const single = Boolean(f.ids?.length) || (Boolean(f.names?.length) && targets.length === 1);
        const offer = plan ? this.offerText(plan) : { name: run.cfg.offer.name, value: { ar: run.cfg.offer.valueProposition, en: run.cfg.offer.valueProposition }, cta: { ar: run.cfg.offer.callToAction, en: run.cfg.offer.callToAction } };
        const res = rewriteItems(targets, instruction, offer, now, single, loc);
        const what = [
          instruction.short ? L(loc, "أقصر", "shorter") : "",
          instruction.direct ? L(loc, "أكثر مباشرة", "more direct") : "",
          instruction.language ? L(loc, `بال${instruction.language === "ar" ? "عربية" : "إنجليزية"}`, `in ${instruction.language === "ar" ? "Arabic" : "English"}`) : "",
          instruction.avoid?.length ? L(loc, `بدون ذكر ${instruction.avoid.join("، ")}`, `without mentioning ${instruction.avoid.join(", ")}`) : "",
          instruction.mention?.length ? L(loc, `مع ذكر ${instruction.mention.join("، ")} حيث يوجد مصدر`, `mentioning ${instruction.mention.join(", ")} where a source supports it`) : "",
        ].filter(Boolean).join(L(loc, " و", " and "));
        if (single) {
          await this.saveReview(run);
          r.say(L(loc, `عدّلت رسالة ${targets[0]?.company ?? ""} لتكون ${what}. راجع «قبل/بعد» في بطاقتها واعتمد التعديل إذا يناسبك.`, `I rewrote the message to ${targets[0]?.company ?? ""} to be ${what}. Check before/after on its card and accept the edit if it works.`), ...res.notes.slice(0, 2));
          return;
        }
        const flagged = targets.filter((i) => i.status === "needs_edit").length;
        await this.saveReview(run, L(loc, `عدّلت ${msgs(loc, targets.length)}: ${what}.`, `Rewrote ${msgs(loc, targets.length)}: ${what}.`));
        r.say(
          L(loc, `تم. عدّلت ${msgs(loc, targets.length)} لتكون ${what}.`, `Done. I rewrote ${msgs(loc, targets.length)} to be ${what}.`),
          flagged ? L(loc, `راجعت ${msgs(loc, flagged)} فيها معلومات غير مؤكدة وتركتها للمراجعة.`, `${msgs(loc, flagged)} contain unconfirmed details — I left them for your review.`) : "",
          res.reopened ? L(loc, `${msgs(loc, res.reopened)} كانت معتمدة ورجعت للمراجعة بعد التعديل.`, `${msgs(loc, res.reopened)} were approved and went back to review after the edit.`) : "",
          ...res.notes.slice(0, 2),
        );
        return;
      }
    }
  }

  private async rerun(run: CampaignRun, plan: CampaignPlan, note: string): Promise<CampaignRun> {
    const cfg = this.configFor(plan, run.id, run.status);
    const snapshot = await this.deps.execute(plan, cfg);
    const counts = countsOf(snapshot);
    const loc = plan.locale;
    const review = buildReview(snapshot, this.offerText(plan), plan.strategy.messageLanguage, { now: this.now(), policy: run.reviewPolicy, previous: run.review, reviewLocale: loc, labels: this.signalLabels(plan) });
    counts.messagesReady = reviewCounts(review).pending;
    const updated: CampaignRun = {
      ...run, cfg, snapshot, counts, review, updatedAt: this.now(),
      activity: [...run.activity, { at: this.now(), text: note, kind: "info" }, ...activityFor(plan, counts, this.now()).slice(1).map((a) => ({ ...a, text: L(loc, `بعد التعديل: ${a.text}`, `After the change: ${a.text}`) }))],
    };
    await this.deps.runs.put(updated);
    return updated;
  }

  private async reply(conv: Conversation, r: Reply) {
    if (!r.cards.length) return;
    const fresh = (await this.deps.conversations.get(conv.id)) ?? conv;
    for (const m of conv.messages) if (!fresh.messages.some((x) => x.id === m.id)) fresh.messages.push(m);
    fresh.messages.push({ id: newId("msg"), role: "agent", at: this.now(), text: r.text.join("\n"), cards: r.cards });
    fresh.updatedAt = this.now();
    fresh.planId = conv.planId ?? fresh.planId;
    fresh.campaignId = conv.campaignId ?? fresh.campaignId;
    fresh.title = conv.title || fresh.title;
    fresh.pendingApprovalId = conv.pendingApprovalId;
    await this.deps.conversations.put(fresh);
  }

  private async require(id: string) {
    const c = await this.deps.conversations.get(id);
    if (!c) throw new Error(`conversation ${id} not found`);
    return c;
  }
}
