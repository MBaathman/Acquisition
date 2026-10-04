import type { AutonomyLevel } from "../config/actions.js";
import type { Locale } from "../config/builder.js";
import { extractGoal, normalize, type CampaignPlan, type PlanChanges, type PlannerContext } from "./planner.js";
import type { ReviewFilter, ReviewPolicy, RewriteInstruction } from "./review.js";

/**
 * Every user message becomes structured intents. Deterministic rules over the
 * knowledge base handle the everyday phrasings (Arabic and English); the
 * intelligence layer's `interpret_message` prompt is used only when the rules
 * find nothing. The agent acts on intents, never on raw text.
 */
export type QueryTopic = "status" | "results" | "top" | "explain" | "approvals" | "plan" | "activity" | "help";

export type AgentIntent =
  | { type: "new_goal"; request: string }
  | { type: "update_plan"; changes: PlanChanges }
  | { type: "answer"; questionId: string; value: string }
  | { type: "confirm" }
  | { type: "reject" }
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "prepare_outreach" }
  | { type: "query"; topic: QueryTopic }
  | { type: "review_approve"; filter: ReviewFilter }
  | { type: "review_exclude"; filter: ReviewFilter }
  | { type: "review_restore"; filter: ReviewFilter }
  | { type: "review_rewrite"; filter: ReviewFilter; rewrite: RewriteInstruction }
  | { type: "review_policy"; policy: ReviewPolicy }
  | { type: "unknown" };

export interface ParseContext {
  planner: PlannerContext;
  plan?: CampaignPlan;
  /** A campaign is already running for this conversation. */
  running?: boolean;
  /** A change is waiting for the user's yes/no. */
  pending?: boolean;
  /** Drafted messages are in review: names the user may refer to ("رسالة سارة", "Oasis"). */
  review?: { names: string[] };
  /** The message was written about one review item (its card's own composer). */
  target?: string;
}

// ---------------------------------------------------------------------------
// The review queue: "اعتمد الرسائل اللي تقييمها فوق 85", "استبعد شركات دبي", "خل الرسائل أقصر"

function reviewFilterIn(t: string, raw: string, ctx: ParseContext): ReviewFilter {
  const f: ReviewFilter = {};
  if (ctx.target) f.ids = [ctx.target];
  // Whole words only: "مها" must not match inside "تقييمها".
  const names = (ctx.review?.names ?? []).filter((n) => normalize(n).length >= 3 && word(normalize(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(t));
  if (names.length) f.names = [...new Set(names)];
  const m = marketsIn(t, ctx.planner);
  if (m.cities.length) f.cities = m.cities;
  const above = t.match(/(?:فوق|اكثر من|اعلي من|above|over|at least|>=?)\s*(\d+)/);
  const below = t.match(/(?:اقل من|تحت|below|under|<)\s*(\d+)(?!\s*(?:عملاء|عميل|client))/);
  const scoreWord = has(t, /تقييم|درج|score|fit|ملاءم/);
  if (above && (scoreWord || Number(above[1]) > 20)) f.minScore = Number(above[1]);
  if (below && scoreWord) f.maxScore = Number(below[1]);
  const top = t.match(/(?:اول|first|top)\s*(\d+)/);
  if (top) f.top = Number(top[1]);
  if (has(t, /(?:وكالات|شركات|جهات|agencies|companies)\s+(?:ال)?(?:كبيره|كبري|large|big)|(?:large|big)\s+(?:agencies|companies)/)) f.large = true;
  const few = t.match(/اقل من\s*(\d+)\s*(?:عملاء|عميل)|(?:fewer|less) than\s*(\d+)\s*clients?/);
  if (few) f.lacksSignal = "عملاء|client";
  if (has(t, /(?:عليها|فيها) تحفظ|المتحفظ|تحتاج تعديل|flagged|needs? edit/)) f.status = ["needs_edit"];
  if (has(t, /الكل|كلها|كلهم|جميع|كل الرسائل|everything|all/)) f.all = true;
  void raw;
  return f;
}

/** Finds a term in the original text, keeping its spelling ("Meta", not "meta"). */
function originalTerm(raw: string, term: string): string {
  const i = raw.toLowerCase().indexOf(term.toLowerCase());
  return i >= 0 ? raw.slice(i, i + term.length) : term;
}

function rewriteIn(t: string, raw: string): RewriteInstruction {
  const r: RewriteInstruction = {};
  if (has(t, /اقصر|مختصر|اختصر|قصيره|shorter|concise|brief/)) r.short = true;
  if (has(t, /مباشر|direct|to the point/)) r.direct = true;
  if (has(t, /بالعربي|بالعربيه|in arabic/)) r.language = "ar";
  else if (has(t, /بالانجليزي|بالانجليزيه|in english/)) r.language = "en";
  const avoid = t.match(/(?:و?لا تذكر|بدون ذكر|شيل ذكر|احذف ذكر|don'?t mention|do not mention|without mentioning)\s+(\S+)/);
  if (avoid) r.avoid = [originalTerm(raw, avoid[1]!)];
  const mention = t.match(/(?:^|\s)و?(?:اذكر|ركز علي|mention|and mention)\s+(\S+)/);
  if (mention && !avoid) r.mention = [originalTerm(raw, mention[1]!)];
  return r;
}

function policyChange(t: string): ReviewPolicy | undefined {
  const auto = t.match(/(?:اعتمد|وافق|approve)\S*\s+(?:تلقائيا|اوتوماتيك|automatically)\D*(\d+)|auto.?approve\D*(\d+)/);
  if (auto) return { mode: "auto", autoAbove: Number(auto[1] ?? auto[2]) };
  if (has(t, /اوافق علي كل رساله|خلني اوافق|موافقتي علي كل رساله|approve every message|manual approval|الموافقه يدوي/)) return { mode: "manual" };
  return undefined;
}

function reviewIntents(t: string, raw: string, ctx: ParseContext): AgentIntent[] {
  const out: AgentIntent[] = [];
  const policy = policyChange(t);
  if (policy) out.push({ type: "review_policy", policy });
  const filter = reviewFilterIn(t, raw, ctx);
  const rewrite = rewriteIn(t, raw);
  const rewriting = Object.keys(rewrite).length > 0 || has(t, /(?:^|\s)(?:عدل|عدلها|غير|اكتب|rewrite|edit|change)\s*(?:ال)?(?:رساله|رسائل|ها|message|messages)?/);
  const isAuto = policy?.mode === "auto";
  if (!isAuto && has(t, /(?:^|\s)(?:اعتمد|اعتمدها|اعتمدهم|وافق علي|approve)(?:\s|$)/)) out.push({ type: "review_approve", filter });
  else if (has(t, /(?:^|\s)(?:استبعد|استبعدها|احذف|شيل|exclude|remove|drop)(?:\s|$)/) && !rewrite.avoid) out.push({ type: "review_exclude", filter });
  else if (has(t, /(?:^|\s)(?:رجع|ارجع|رجعها|restore|bring back)(?:\s|$)/)) out.push({ type: "review_restore", filter });
  else if (rewriting && (ctx.target || Object.keys(rewrite).length || has(t, /رساله|رسائل|الرسائل|message/))) out.push({ type: "review_rewrite", filter, rewrite });
  return out;
}

const has = (t: string, ...patterns: RegExp[]) => patterns.some((p) => p.test(t));
// Arabic negation that applies to the next verb ("لا تبدأ", "لا ترسل", "don't start").
const NEG = String.raw`(?:لا|ما|بدون|مو|don'?t|do not|never|no)\s+`;
const word = (w: string) => new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:و|ف|ب|ل|ال)?${w}(?:$|[^\p{L}\p{N}])`, "u");

function numberIn(t: string): number | undefined {
  const m = t.match(/(\d[\d,.]*)\s*(مليون|million|m\b|الف|k\b)?/);
  if (!m) return undefined;
  const n = Number(m[1]!.replace(/,/g, ""));
  const mult = m[2] ? (/مليون|million|m/.test(m[2]) ? 1_000_000 : 1_000) : 1;
  return Number.isFinite(n) ? n * mult : undefined;
}

/** Markets mentioned in the text, ignoring the ones being replaced ("السعودية بدل الإمارات"). */
function marketsIn(t: string, ctx: PlannerContext): { countries: string[]; cities: string[] } {
  const kept = t.split(/\s(?:بدل|بدلا من|بدال|عوضا عن|مو|وليس|instead of|rather than|not)\s/)[0]!;
  const x = extractGoal(kept, ctx);
  return { countries: x.countries, cities: x.cities };
}

/** Matches a free-text reply to one of the open questions. */
function answerFor(t: string, plan: CampaignPlan, ctx: PlannerContext): { questionId: string; value: string } | undefined {
  for (const q of plan.questions) {
    const kb = ctx.knowledge.questions[q.id];
    if (!kb) continue;
    if (kb.effect === "goal") {
      const n = numberIn(t);
      if (n && n > 0) return { questionId: q.id, value: String(Math.round(n)) };
    }
    if (kb.effect === "country") {
      const m = marketsIn(t, ctx);
      if (m.countries[0]) return { questionId: q.id, value: m.countries[0] };
    }
    if (kb.effect === "budget") {
      if (has(t, /بدون|لا يهم|no min|none/)) return { questionId: q.id, value: "none" };
      const n = numberIn(t);
      if (n && n >= 10_000) return { questionId: q.id, value: String(n) };
    }
    if (kb.effect === "cities") {
      const m = marketsIn(t, ctx);
      if (m.cities.length) return { questionId: q.id, value: m.cities.join(",") };
    }
    let best: { id: string; len: number } | undefined;
    for (const o of q.options) {
      for (const a of [o.label, ...(o.aliases ?? [])]) {
        const n = normalize(a);
        if (n && (t === n || word(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(t)) && (!best || n.length > best.len)) best = { id: o.id, len: n.length };
      }
    }
    if (best) return { questionId: q.id, value: best.id };
    if (kb.custom === "text" && t.length > 6) return { questionId: q.id, value: t };
  }
  return undefined;
}

function changesIn(t: string, ctx: ParseContext): PlanChanges {
  const c: PlanChanges = {};
  const kb = ctx.planner.knowledge;
  const plan = ctx.plan;

  // Market / city focus.
  const m = marketsIn(t, ctx.planner);
  if (m.cities.length) c.cities = m.cities;
  if (m.countries.length) c.countries = m.countries;

  // Goal: "خل الهدف 200", "goal 200", "make it 200".
  const g = t.match(/(?:الهدف|هدف|goal|target)\D{0,14}(\d[\d,]*)/) ?? t.match(/(?:خله|خليه|خلها|make it)\s+(\d[\d,]*)(?!\s*(?:عميل|عملاء|client))/);
  if (g) c.goal = Number(g[1]!.replace(/,/g, ""));

  // Minimum clients: "عندها أكثر من 3 عملاء", "5 عملاء أو أكثر", "with 5+ clients".
  const mc = t.match(/(اكثر من|علي الاقل|at least|more than)?\s*(\d+)\s*\+?\s*(?:عملاء|عميل|clients?)(\s*(?:او اكثر|فاكثر|or more))?/);
  if (mc && (mc[1] || mc[3] || /\+\s*(?:عملاء|عميل|client)/.test(t) || has(t, /عندها|لديها|تخدم|تدير|with|have|has|serving|manag/)) && !c.goal) {
    const n = Number(mc[2]);
    c.minClients = /اكثر من|more than/.test(mc[1] ?? "") ? n + 1 : n;
  }

  // Company size.
  if (has(t, new RegExp(`${NEG}(?:تستهدف|تستهدفون|target)?\\s*(?:ال)?شركات (?:ال)?(?:كبيره|كبرى)`), /(?:no|not|exclude|without)\s+(?:the\s+)?(?:large|big)\s+(?:companies|firms)/, /بدون (?:ال)?شركات (?:ال)?كبيره/)) {
    const cap = kb.defaults.excludeLargeMax ?? 200;
    c.sizeMax = Math.min(plan?.strategy.size?.max ?? cap, cap);
  }
  if (has(t, /كل الاحجام|جميع الاحجام|all sizes|any size/)) { c.sizeMin = null; c.sizeMax = null; }
  const range = t.match(/(\d+)\s*[-–الى to]+\s*(\d+)\s*(?:موظف|employees|staff)/);
  if (range) { c.sizeMin = Number(range[1]); c.sizeMax = Number(range[2]); }

  // Channels.
  if (has(t, /(?:البريد|الايميل|ايميل|الإيميل|email)\s*(?:فقط|بس|only)/, /(?:only|just)\s+email/, /(?:بس|فقط)\s+(?:البريد|الايميل|ايميل)/)) c.channels = { email: true, linkedin: false };
  else if (has(t, /(?:لينكدان|لينكد ان|linkedin)\s*(?:فقط|بس|only)/, /only\s+linkedin/)) c.channels = { email: false, linkedin: true };
  else {
    if (has(t, new RegExp(`${NEG}(?:تستخدم|تستعمل|use)?\\s*(?:لينكدان|لينكد ان|linkedin)`), /(?:without|no)\s+linkedin/)) c.channels = { ...c.channels, linkedin: false };
    else if (has(t, /(?:استخدم|ضيف|اضف|add|use)\s+(?:لينكدان|لينكد ان|linkedin)/)) c.channels = { ...c.channels, linkedin: true };
    if (has(t, new RegExp(`${NEG}(?:تستخدم|تستعمل|use)?\\s*(?:البريد|الايميل|ايميل|email)`))) c.channels = { ...c.channels, email: false };
  }

  // Message language.
  if (has(t, /بالعربي|باللغه العربيه|in arabic|arabic messages|messages in arabic/)) c.language = "ar";
  else if (has(t, /بالانجليزي|باللغه الانجليزيه|in english|english messages|messages in english/)) c.language = "en";

  // Decision makers only.
  if (has(t, /اصحاب القرار|صناع القرار|صاحب القرار|decision makers?/)) c.decisionMakersOnly = !has(t, new RegExp(`${NEG}(?:بس|فقط)?\\s*اصحاب القرار`), /not only decision/);

  // Qualification threshold: "ارفع درجة التأهيل إلى 80".
  const th = t.match(/(?:درجه|حد|threshold|score)\s*(?:ال)?(?:تاهيل|ملاءمه|ملائمه|qualification|fit)?\D{0,12}(\d+)/);
  if (th) c.threshold = Number(th[1]);

  // Approval policy. Stricter is always fine; looser is a change that needs approval.
  const autonomy = policyIn(t);
  if (autonomy) c.autonomy = autonomy;
  return c;
}

function policyIn(t: string): AutonomyLevel | undefined {
  if (has(t, /الا بعد موافقتي|بدون موافقتي|بموافقتي|اوافق علي كل|اوافق عليها|موافقتي علي كل|approve every|my approval|without approval from me|i approve/)) {
    const looser = has(t, /^(?:ارسل|send)\b/) && !has(t, new RegExp(NEG));
    return looser ? "autonomous" : "human_approval";
  }
  if (has(t, /ارسل تلقائيا|تلقائي بالكامل|send automatically|fully autonomous|autonomous/)) return "autonomous";
  if (has(t, /شبه تلقائي|assisted/)) return "assisted";
  return undefined;
}

const START = /(?:^|\s)(?:ابدا|ابدء|يلا ابدا|start|go ahead|انطلق|شغل الحمله|اعتمد وابدا)/;
const NEGATED_START = new RegExp(`${NEG}(?:تبدا|تبدء|ابدا|start)`);

export function parseMessage(raw: string, ctx: ParseContext): AgentIntent[] {
  const t = normalize(raw).replace(/[؟?!.،,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return [{ type: "unknown" }];

  // No plan yet: the message is the goal.
  if (!ctx.plan && !ctx.running) return [{ type: "new_goal", request: raw.trim() }];

  // A different goal mid-conversation ("أبغى 20 اجتماع مؤهل لـ...") opens a new one.
  if (ctx.plan) {
    const x = extractGoal(raw, ctx.planner);
    const wants = has(t, /ابغي|ابي|اريد|نبي|نبغي|i want|we want|i need|we need/);
    if (wants && x.outcome && x.archetype && (x.archetype !== ctx.plan.understanding.audience.archetype || x.outcome !== ctx.plan.understanding.outcome.preset)) {
      return [{ type: "new_goal", request: raw.trim() }];
    }
  }

  // A yes/no to a pending plan change wins over everything else.
  if (ctx.pending && has(t, /^(?:نعم|ايه|ايوه|تمام|موافق|اعتمد|اعتمده|اعتمد التعديل|ok|yes|approve|confirm)$/)) return [{ type: "confirm" }];
  if (ctx.pending && has(t, /^(?:لا|الغ|الغيه|cancel|no|رفض)$/)) return [{ type: "reject" }];

  const out: AgentIntent[] = [];
  const review = ctx.review || ctx.target ? reviewIntents(t, raw, ctx) : [];
  out.push(...review);
  const answer = ctx.plan && ctx.plan.questions.length ? answerFor(t, ctx.plan, ctx.planner) : undefined;
  if (answer) out.push({ type: "answer", ...answer });

  const changes = changesIn(t, ctx);
  // An answer already covers what it matched; don't double-apply it as a change.
  if (answer?.questionId === "market") delete changes.countries;
  if (answer?.questionId === "goal") delete changes.goal;
  if (answer?.questionId === "region_focus") delete changes.cities;
  if (answer?.questionId === "company_size") { delete changes.sizeMin; delete changes.sizeMax; }
  // Words that select messages ("شركات دبي", "فوق 85", "أقل من 3 عملاء") are filters here, not plan changes.
  if (review.some((i) => i.type !== "review_policy")) {
    for (const k of ["countries", "cities", "goal", "minClients", "threshold", "sizeMin", "sizeMax"] as const) delete changes[k];
  }
  if (review.some((i) => i.type === "review_policy" && i.policy.mode === "auto")) delete changes.autonomy;
  if (ctx.target) for (const k of Object.keys(changes) as (keyof PlanChanges)[]) delete changes[k];
  if (Object.keys(changes).length) out.push({ type: "update_plan", changes });

  if (has(t, /جهز (?:ال)?تواصل|جهز (?:ال)?رسائل|اكتب (?:ال)?رسائل|prepare (?:the )?outreach|draft (?:the )?messages|prepare (?:the )?messages/)) out.push({ type: "prepare_outreach" });
  if (has(t, START) && !has(t, NEGATED_START) && !out.some((i) => i.type === "prepare_outreach")) out.push({ type: "start" });
  if (has(t, /(?:^|\s)(?:وقف|اوقف|توقف|pause|stop the campaign|hold)(?:\s|$)/) && !has(t, new RegExp(`${NEG}(?:توقف|وقف)`))) out.push({ type: "pause" });
  if (has(t, /استانف|كمل الحمله|resume|continue the campaign|unpause/, word("واصل"))) out.push({ type: "resume" });

  const query: QueryTopic | undefined =
    has(t, /افضل (?:ال)?فرص|اقوى (?:ال)?فرص|best (?:opportunities|prospects|matches)|top (?:opportunities|prospects)/) ? "top"
    : has(t, word("ليش"), word("ليه"), word("لماذا"), /\bwhy\b/) ? "explain"
    : has(t, /وش (?:لقيت|اكتشفت|وجدت)|ماذا (?:وجدت|اكتشفت)|ورني (?:وش|ايش|اللي)|اعرض (?:ال)?نتائج|what did you find|show me what|show (?:me )?(?:the )?results/) ? "results"
    : has(t, /يحتاج موافقتي|تحتاج موافقتي|الموافقات|what needs my approval|pending approvals|approvals/) ? "approvals"
    : has(t, /^كم|كم (?:شركه|جهه|عميل|واحد)|how many|وش الوضع|وين وصلت|status|progress/) ? "status"
    : has(t, /وش (?:الخطه|خطتك)|اعرض (?:ال)?خطه|show (?:me )?the plan|what'?s the plan/) ? "plan"
    : has(t, /وش (?:تسوي|سويت)|نشاط|activity|what are you doing/) ? "activity"
    : has(t, /^(?:مساعده|help|وش تقدر)/) ? "help"
    : undefined;
  if (query) out.push({ type: "query", topic: query });

  if (!out.length) {
    if (has(t, /^(?:نعم|ايه|ايوه|اي|تمام|اوكي|موافق|اعتمد|اعتمد التعديل|اعتمده|طيب|ok|okay|yes|approve|confirm|sure|go)$/)) out.push({ type: "confirm" });
    else if (has(t, /^(?:لا|الغ|الغيه|cancel|no|nope|رفض)$/)) out.push({ type: "reject" });
  }
  return out.length ? out : [{ type: "unknown" }];
}

/** The model's interpretation is reduced to the same intents and checked against what the product knows. */
export function sanitizeIntents(intents: AgentIntent[], ctx: ParseContext): AgentIntent[] {
  const kb = ctx.planner.knowledge;
  const regions = new Set(kb.regions.map((r) => r.code));
  const cities = new Set(kb.regions.flatMap((r) => r.cities.map((c) => c.key)));
  const out: AgentIntent[] = [];
  for (const i of intents) {
    if (i.type === "update_plan") {
      const c = i.changes;
      const s: PlanChanges = {};
      if (c.countries?.length) s.countries = c.countries.filter((x) => regions.has(x));
      if (c.cities?.length) s.cities = c.cities.filter((x) => cities.has(x));
      if (typeof c.goal === "number" && c.goal > 0) s.goal = Math.min(Math.round(c.goal), 100_000);
      if (c.sizeMin !== undefined) s.sizeMin = c.sizeMin === null ? null : Math.max(1, Math.round(c.sizeMin));
      if (c.sizeMax !== undefined) s.sizeMax = c.sizeMax === null ? null : Math.max(1, Math.round(c.sizeMax));
      if (typeof c.minClients === "number" && c.minClients > 0) s.minClients = Math.round(c.minClients);
      if (c.channels) s.channels = { email: c.channels.email, linkedin: c.channels.linkedin };
      if (c.language === "ar" || c.language === "en") s.language = c.language as Locale;
      if (typeof c.threshold === "number" && c.threshold > 0) s.threshold = Math.round(c.threshold);
      if (typeof c.decisionMakersOnly === "boolean") s.decisionMakersOnly = c.decisionMakersOnly;
      if (c.autonomy && ["human_approval", "assisted", "autonomous"].includes(c.autonomy)) s.autonomy = c.autonomy;
      for (const k of Object.keys(s) as (keyof PlanChanges)[]) if (Array.isArray(s[k]) && !(s[k] as unknown[]).length) delete s[k];
      if (Object.keys(s).length) out.push({ type: "update_plan", changes: s });
    } else if (i.type === "answer") {
      if (ctx.plan?.questions.some((q) => q.id === i.questionId)) out.push(i);
    } else out.push(i);
  }
  return out.length ? out : [{ type: "unknown" }];
}
