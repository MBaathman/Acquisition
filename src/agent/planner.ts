import type { AutonomyLevel } from "../config/actions.js";
import type { CampaignDraft, CriterionCheck, Locale, OutcomePreset } from "../config/builder.js";

/**
 * The acquisition agent's planner: one sentence ("what") → a structured,
 * persistable Campaign Plan ("how").
 *
 * Planning is split in two so the LLM is optional and replaceable:
 *
 *   text ──► extractGoal()  (rules over the knowledge base, or the LLM via
 *            │               the intelligence layer — same GoalExtraction shape)
 *            ▼
 *   GoalExtraction ──► buildPlan()  (deterministic: archetype, signals,
 *                                    threshold, channels, questions, draft)
 *
 * Everything domain-specific (outcome vocabulary, markets, audience
 * archetypes, questions) is data in presets/knowledge.json.
 */

type Text = Record<Locale, string>;

export interface KnowledgeRegion {
  code: string;
  name: Text;
  aliases: string[];
  language: Locale;
  cities: { key: string; name: Text; aliases: string[] }[];
  focusCities: string[];
}

export interface KnowledgeSignal {
  label: Text;
  points: number;
  timing?: boolean;
  check?: "size" | "role" | "location" | "budget";
  /** A label parameter the conversation can change, e.g. "{n}+ clients". */
  param?: "minClients";
  paramDefault?: number;
}

export interface KnowledgeArchetype {
  key: string;
  fallback?: boolean;
  keywords: string[];
  label: Text;
  short: Text;
  campaignName: Text;
  targetType: "account" | "individual";
  companyTypes: Record<Locale, string[]>;
  size?: { min?: number; max?: number };
  titles: Record<Locale, string[]>;
  signals: KnowledgeSignal[];
  summarySignals: Record<Locale, string[]>;
  needs?: Record<Locale, string[]>;
  understood: Text;
  assumptions: Record<Locale, string[]>;
  question?: string;
  /** companies (B2B accounts) · people (a role inside companies) · individuals (consumers). */
  kind?: "companies" | "people" | "individuals" | null;
  /** Broad area; switching audience across domains is confirmed first. */
  domain?: string | null;
  /** The audience people often mean instead (e.g. media buyers ↔ media-buying firms). */
  counterpart?: string;
  /** Only contacts with these titles fit (role-based audiences). */
  requireTitle?: boolean;
  budgetOptions?: number[];
  budgetCurrency?: string;
  industry?: string;
  /** Name fragments for fictional simulated prospects. */
  namePool?: { a: string[]; b: string[] };
}

export interface KnowledgeQuestion {
  text: Text;
  effect: "goal" | "country" | "cities" | "companyTypes" | "budget" | "audience" | "size" | "client" | "archetype";
  options: { id: string; label: Text; custom?: string; aliases?: string[]; companyTypes?: Record<Locale, string[]> | null }[];
  custom?: string;
  default?: string;
}

export interface Knowledge {
  outcomes: Record<string, string[]>;
  offerHints: { keywords: string[]; cta: Text }[];
  autonomyHints: Partial<Record<AutonomyLevel, string[]>>;
  regions: KnowledgeRegion[];
  archetypes: KnowledgeArchetype[];
  questions: Record<string, KnowledgeQuestion>;
  defaults: {
    outcome: string;
    goal: number;
    country: string;
    placeholderClient: Text;
    offer: { valueProposition: Text; mainMessage: Text; mainMessageIndividual: Text };
    minClientsLabel?: Text;
    excludeLargeMax?: number;
  };
  /** Title keywords that mark a decision maker. */
  seniorTitleKeywords?: string[];
  /** Company-size phrases the user can say ("الشركات الكبيرة"). */
  sizePresets?: Record<string, { min: number | null; max: number | null; keywords: string[]; label: Text }>;
}

export interface PlannerContext {
  knowledge: Knowledge;
  outcomes: OutcomePreset[];
  /** Existing clients, matched by name before anything else. */
  clients?: { id: string; name: string }[];
  locale: Locale;
}

/** What was understood from the request. The LLM path returns the same shape. */
export interface GoalExtraction {
  clientName: string | null;
  outcome: string | null;
  goal: number | null;
  countries: string[];
  cities: string[];
  archetype: string | null;
  /** Free-text audience, used when no archetype matches. */
  audience: string | null;
  cta: string | null;
  autonomy: AutonomyLevel | null;
}

export interface PlanQuestion {
  id: string;
  text: string;
  options: { id: string; label: string; custom?: string; aliases?: string[] }[];
  custom?: string;
  default?: string;
}

export interface PlanAssumption {
  id: string;
  text: string;
  status: "proposed" | "accepted" | "edited";
}

/** The campaign as the conversation has defined it so far. Unknown stays null — nothing is borrowed from an example campaign. */
export interface AgentCampaignState {
  client: { id: string; name: string | null; existing: boolean };
  outcome: { preset: string; label: string; goal: number | null };
  audience: {
    archetype: string | null;
    kind: "companies" | "people" | "individuals" | null;
    label: string | null;
    description: string | null;
    companyTypes: string[];
    titles: string[];
  };
  companySize: { min: number | null; max: number | null; label: string } | null;
  geography: { countries: string[]; cities: string[]; place: string };
  channels: string[];
  language: Locale;
  offer: { cta: string };
  qualification: { threshold: number; maxScore: number; minClients: number | null; decisionMakersOnly: boolean; minBudget: number | null };
  approval: { mode: "manual" | "auto"; autoAbove: number | null };
  autonomy: AutonomyLevel;
  /** user = said in the conversation · inferred = follows from the audience · default = product default. */
  provenance: Record<string, "user" | "inferred" | "default">;
}

export interface ChangeLogEntry {
  n: number;
  at: string;
  field: string;
  label: string;
  from: string;
  to: string;
  /** What caused it: the first sentence, a later message, or an answer to a question. */
  source: "initial" | "message" | "answer";
  messageId?: string;
}

export interface CampaignPlan {
  version: 1;
  id: string;
  request: string;
  locale: Locale;
  createdAt: string;
  /** How the request was understood: rules over the knowledge base, or the LLM. */
  understoodBy: "rules" | "llm";
  extraction: GoalExtraction;
  answers: Record<string, string>;
  /** Everything the user changed in conversation, re-applied on every rebuild. */
  changes: PlanChanges;
  /** Consequences the agent applied and should mention (e.g. a widened size band). */
  notes: string[];
  /** THE source of truth for the campaign: every view (plan, outreach, approvals, progress) reads this. */
  state: AgentCampaignState;
  /** Every change to the state: field, before → after, and what caused it. */
  changeLog: ChangeLogEntry[];
  status: "needs_input" | "ready" | "approved";
  understanding: {
    client: { id: string; name: string; existing: boolean; placeholder: boolean };
    outcome: { preset: string; label: string; plural: string; goal: number; goalStated: boolean };
    market: { countries: string[]; cities: string[]; place: string };
    audience: { archetype: string; label: string; kind: "companies" | "people" | "individuals" | null; companyTypes: string[]; titles: string[]; needs: string[] };
  };
  explanation: { understood: string; research: string[]; why: string; need: string[] };
  assumptions: PlanAssumption[];
  questions: PlanQuestion[];
  strategy: {
    threshold: number;
    maxScore: number;
    /** Scoring signals in plan order (criterion_1, criterion_2...), with the label in both languages for messages. */
    signals: { label: string; labels: Record<Locale, string>; points: number; timing: boolean }[];
    channels: string[];
    touches: number;
    waitDays: number;
    channelKeys: string[];
    autonomy: AutonomyLevel;
    messageLanguage: Locale;
    size: { min: number | null; max: number | null } | null;
    sizeLabel: string;
    minClients: number | null;
    decisionMakersOnly: boolean;
    approval: { mode: "manual" | "auto"; autoAbove: number | null };
  };
  draft: CampaignDraft;
}

// ---------------------------------------------------------------------------
// Text helpers

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Lowercase, unify Arabic letter variants, drop diacritics/tatweel, ASCII digits. */
export function normalize(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[\u064B-\u0652\u0640]/g, "") // diacritics, tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Longest keyword found in the text (word-ish boundaries; Arabic prefixes like ال/لـ/و allowed). */
function longestMatch(text: string, keywords: string[]): string | undefined {
  let best: string | undefined;
  for (const k of keywords) {
    const kw = normalize(k);
    if (!kw) continue;
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:وال|بال|لل|ال|ل|و|ب)?${escapeRe(kw)}(?:$|[^\\p{L}\\p{N}])`, "u");
    if (re.test(text) && (!best || kw.length > best.length)) best = kw;
  }
  return best;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** ASCII slug for ids (config keys must be lowercase ASCII); non-Latin text falls back to a short hash. */
const slug = (s: string) => {
  const ascii = normalize(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (ascii.length >= 2) return ascii;
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `x${h.toString(36)}`;
};
const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
/** Count phrases: Arabic uses the plural form only for 3–10 ("5 مشتركون", "100 مشترك"). */
export function countOf(loc: Locale, n: number, singular: string, plural: string): string {
  if (loc === "ar") return `${n} ${n >= 3 && n <= 10 ? plural : singular}`;
  return `${n} ${n === 1 ? singular : plural}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

// ---------------------------------------------------------------------------
// Step 1 — deterministic understanding

export function extractGoal(request: string, ctx: PlannerContext): GoalExtraction {
  const kb = ctx.knowledge;
  const text = normalize(request);

  // Client: an existing client mentioned by name, else a Latin name after "لـ"/"for".
  let clientName: string | null = null;
  const existing = (ctx.clients ?? [])
    .filter((c) => c.name && text.includes(normalize(c.name)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (existing) clientName = existing.name;
  else {
    const m = request.match(/(?:لـ\s*|ل\s+|\bfor\s+)([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/u);
    if (m) clientName = m[1]!.trim();
  }

  // Goal: the first number that is not part of a budget ("5 مليون", "3M").
  let goal: number | null = null;
  for (const m of text.matchAll(/(\d[\d,]*)(\s*(?:مليون|الف|ألف|million|k\b|m\b))?/g)) {
    if (m[2]) continue;
    goal = Number(m[1]!.replace(/,/g, ""));
    break;
  }

  // Outcome type.
  let outcome: string | null = null;
  let outcomeLen = 0;
  for (const [key, words] of Object.entries(kb.outcomes)) {
    const hit = longestMatch(text, words);
    if (hit && hit.length > outcomeLen) [outcome, outcomeLen] = [key, hit.length];
  }

  // Market.
  const countries = new Set<string>();
  const cities: string[] = [];
  for (const r of kb.regions) {
    if (longestMatch(text, r.aliases)) countries.add(r.code);
    for (const c of r.cities) {
      if (longestMatch(text, c.aliases)) {
        cities.push(c.key);
        countries.add(r.code);
      }
    }
  }

  // Audience archetype.
  let archetype: string | null = null;
  let archLen = 0;
  for (const a of kb.archetypes) {
    const hit = longestMatch(text, a.keywords);
    if (hit && hit.length > archLen) [archetype, archLen] = [a.key, hit.length];
  }
  let audience: string | null = null;
  if (!archetype) {
    const m = request.match(/(?:\sمن\s|\sمع\s|\bfrom\s|\bwith\s)(.+?)(?:\sفي\s|\bin\s|$)/u);
    audience = m?.[1]?.trim() || null;
  }

  const cta = kb.offerHints.find((h) => longestMatch(text, h.keywords))?.cta[ctx.locale] ?? null;
  let autonomy: AutonomyLevel | null = null;
  for (const [level, words] of Object.entries(kb.autonomyHints)) if (words && longestMatch(text, words)) autonomy = level as AutonomyLevel;

  return { clientName, outcome, goal, countries: [...countries], cities, archetype, audience, cta, autonomy };
}

/** Keeps only values the knowledge base knows, so an LLM extraction can't inject unknown keys. */
export function sanitizeExtraction(x: GoalExtraction, ctx: PlannerContext): GoalExtraction {
  const kb = ctx.knowledge;
  const regionCodes = new Set(kb.regions.map((r) => r.code));
  const cityKeys = new Set(kb.regions.flatMap((r) => r.cities.map((c) => c.key)));
  const goal = x.goal !== null && Number.isFinite(x.goal) && x.goal > 0 ? Math.min(Math.round(x.goal), 100_000) : null;
  return {
    clientName: x.clientName?.trim().slice(0, 80) || null,
    outcome: x.outcome && ctx.outcomes.some((o) => o.key === x.outcome) ? x.outcome : null,
    goal,
    countries: x.countries.filter((c) => regionCodes.has(c)),
    cities: x.cities.filter((c) => cityKeys.has(c)),
    archetype: x.archetype && kb.archetypes.some((a) => a.key === x.archetype && !a.fallback) ? x.archetype : null,
    audience: x.audience?.trim().slice(0, 200) || null,
    cta: x.cta?.trim().slice(0, 80) || null,
    autonomy: x.autonomy && ["human_approval", "assisted", "autonomous"].includes(x.autonomy) ? x.autonomy : null,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — deterministic plan

/**
 * Structured changes the user asked for in conversation ("خلها السعودية",
 * "استخدم البريد فقط", "ارفع درجة التأهيل إلى 80"...). They accumulate on the
 * plan and are re-applied on every rebuild, so nothing the user said is lost.
 */
export interface PlanChanges {
  /** Replace the audience (a knowledge archetype); null = back to "not set". */
  archetype?: string | null;
  /** Free-text audience when no archetype fits ("مطاعم في الرياض"). */
  audienceDescription?: string;
  /** The user said which kind they meant (people vs companies) — don't ask again. */
  audienceExplicit?: boolean;
  /** Audiences ADDED to the main one ("أضف ميديا بايرز مع الوكالات"). */
  alsoArchetypes?: string[];
  sizePreset?: string;
  /** Batch approval rule for drafted messages ("اعتمد كل الرسائل اللي فوق 85"). */
  approval?: { mode: "manual" | "auto"; autoAbove?: number };
  countries?: string[];
  cities?: string[];
  goal?: number;
  /** null = no bound. */
  sizeMin?: number | null;
  sizeMax?: number | null;
  minClients?: number;
  channels?: { email?: boolean; linkedin?: boolean };
  language?: Locale;
  threshold?: number;
  decisionMakersOnly?: boolean;
  autonomy?: AutonomyLevel;
}

export const CHANGE_KEYS = ["countries", "cities", "goal", "sizeMin", "sizeMax", "minClients", "channels", "language", "threshold", "decisionMakersOnly", "autonomy"] as const;

/** Later changes win (replace, not add); `channels` merges. */
export function mergeChanges(a: PlanChanges, b: PlanChanges): PlanChanges {
  const out: PlanChanges = { ...a, ...b };
  if (a.channels || b.channels) out.channels = { ...a.channels, ...b.channels };
  // A new audience replaces the old one and whatever was only about it.
  if (b.archetype !== undefined && b.archetype !== a.archetype) {
    if (b.audienceDescription === undefined) delete out.audienceDescription;
    if (b.audienceExplicit === undefined) delete out.audienceExplicit;
  }
  if (b.audienceDescription !== undefined && b.archetype === undefined) out.archetype = null;
  if (b.sizePreset !== undefined) { delete out.sizeMin; delete out.sizeMax; }
  if (b.sizeMin !== undefined || b.sizeMax !== undefined) delete out.sizePreset;
  if (b.countries && !b.cities) delete out.cities; // a new market resets city focus unless cities came with it
  return out;
}

const COPY: Record<Locale, {
  why: (signals: string) => string;
  goalAssumed: (n: number) => string;
  marketAssumed: (place: string) => string;
  outcomeAssumed: (label: string) => string;
  languageAssumed: (lang: string) => string;
  clientAssumed: string;
  offerAssumed: string;
  approval: string;
  approvalAssisted: string;
  approvalAuto: string;
  channels: (list: string, touches: number, days: number) => string;
  threshold: (t: number, max: number) => string;
  widenedSize: (min: number, max: number) => string;
  langName: Record<Locale, string>;
  and: string;
}> = {
  ar: {
    why: (s) => `اخترت هذه الإشارات لأنها الأقرب لتحقيق النتيجة: ${s}.`,
    goalAssumed: (n) => `الهدف ${n} (لم يُذكر رقم)`,
    marketAssumed: (p) => `السوق: ${p}`,
    outcomeAssumed: (l) => `نوع النتيجة: ${l}`,
    languageAssumed: (l) => `الرسائل ب${l} في البداية — يمكنك تغيير ذلك متى أردت`,
    clientAssumed: "العميل غير محدد — سأنشئ عميلاً جديداً ويمكنك تسميته لاحقاً",
    offerAssumed: "سأكتب العرض من وصف العميل — قل لي إن أردت تعديله",
    approval: "كل رسالة خارجية تنتظر موافقتك قبل الإرسال",
    approvalAssisted: "الرسائل عالية الثقة تُرسل تلقائياً، والباقي ينتظر موافقتك",
    approvalAuto: "الرسائل تُرسل تلقائياً ضمن حدود الحملة",
    channels: (l, t, d) => `التواصل عبر ${l}، ${t === 2 ? "رسالتان" : "رسالة واحدة"} بينهما ${d} أيام`,
    threshold: (t, m) => `نتواصل فقط مع من تتجاوز درجته ${t} من ${m}`,
    widenedSize: (a, b) => `هذا سيقلل حجم السوق المتوقع، لذلك وسّعت نطاق الشركات إلى ${a}–${b} موظف.`,
    langName: { ar: "العربية", en: "الإنجليزية" },
    and: " و",
  },
  en: {
    why: (s) => `I picked these signals because they best predict the outcome: ${s}.`,
    goalAssumed: (n) => `Goal of ${n} (no number was given)`,
    marketAssumed: (p) => `Market: ${p}`,
    outcomeAssumed: (l) => `Outcome type: ${l}`,
    languageAssumed: (l) => `Messages in ${l} to start — change it any time`,
    clientAssumed: "No client named — I'll create a new one you can rename",
    offerAssumed: "I'll write the offer from the client description — tell me if you want it changed",
    approval: "Every outbound message waits for your approval",
    approvalAssisted: "High-confidence messages go out automatically; the rest wait for you",
    approvalAuto: "Messages go out automatically within the campaign limits",
    channels: (l, t, d) => `Reach out by ${l}, ${t} touch${t === 2 ? "es" : ""} ${d} days apart`,
    threshold: (t, m) => `Only contact prospects scoring ${t}+ out of ${m}`,
    widenedSize: (a, b) => `That shrinks the expected market, so I widened company size to ${a}–${b} employees.`,
    langName: { ar: "Arabic", en: "English" },
    and: " and ",
  },
};

const CHANNEL_NAMES: Record<string, Text> = { email: { ar: "البريد", en: "email" }, linkedin: { ar: "LinkedIn", en: "LinkedIn" } };

/** What the agent decides itself, what it asks about, and what needs approval. */
export const DECISION_POLICY: { key: string; mode: "auto" | "ask" | "approval"; label: Text }[] = [
  { key: "discover", mode: "auto", label: { ar: "البحث عن الجهات", en: "Finding prospects" } },
  { key: "score", mode: "auto", label: { ar: "تقييم الجهات وترتيب الأولويات", en: "Scoring and prioritizing" } },
  { key: "draft", mode: "auto", label: { ar: "كتابة الرسائل المقترحة", en: "Drafting messages" } },
  { key: "ambiguity", mode: "ask", label: { ar: "معلومة مؤثرة غير واضحة", en: "An unclear detail that matters" } },
  { key: "send", mode: "approval", label: { ar: "إرسال أي رسالة حقيقية", en: "Sending any real message" } },
  { key: "strategy", mode: "approval", label: { ar: "تغيير جوهري في حملة تعمل", en: "A major change to a running campaign" } },
];

export interface BuildPlanOptions {
  id?: string;
  request?: string;
  createdAt?: string;
  understoodBy?: "rules" | "llm";
  answers?: Record<string, string>;
  changes?: PlanChanges;
  changeLog?: ChangeLogEntry[];
  assumptionStatus?: Record<string, PlanAssumption["status"]>;
}

/** Edit distance, for "did you mean the client you already have?". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
const compact = (s: string) => normalize(s).replace(/[^\p{L}\p{N}]/gu, "");

export function buildPlan(extraction: GoalExtraction, ctx: PlannerContext, opts: BuildPlanOptions = {}): CampaignPlan {
  const kb = ctx.knowledge;
  const loc = ctx.locale;
  const copy = COPY[loc];
  const answers = { ...(opts.answers ?? {}) };
  const ch = opts.changes ?? {};
  const x = extraction;
  const notes: string[] = [];

  const archetypeKey = ch.archetype !== undefined ? ch.archetype : x.archetype;
  const arch = kb.archetypes.find((a) => a.key === archetypeKey && !a.fallback) ?? kb.archetypes.find((a) => a.fallback)!;
  const audienceKnown = !arch.fallback || Boolean(ch.audienceDescription ?? x.audience);
  const preset = ctx.outcomes.find((o) => o.key === (x.outcome ?? kb.defaults.outcome)) ?? ctx.outcomes[0]!;
  const individual = arch.targetType === "individual";

  // Market: request → answers → conversation changes.
  let countries = x.countries.length ? [...x.countries] : [];
  if (answers.market) countries = [answers.market];
  if (ch.countries?.length) countries = [...ch.countries];
  const marketKnown = countries.length > 0;
  if (!marketKnown) countries = [kb.defaults.country];
  let cities = ch.countries?.length && !ch.cities ? [] : [...x.cities];
  if (answers.region_focus === "focus") cities = [...(kb.regions.find((r) => r.code === countries[0])?.focusCities ?? [])];
  else if (answers.region_focus === "all") cities = [];
  else if (answers.region_focus && !["focus", "all", "custom"].includes(answers.region_focus)) cities = answers.region_focus.split(",").map((s) => s.trim()).filter(Boolean);
  if (ch.cities) cities = [...ch.cities];
  const regions = countries.map((c) => kb.regions.find((r) => r.code === c)).filter((r): r is KnowledgeRegion => Boolean(r));
  // A city implies its country.
  for (const c of cities) {
    const r = kb.regions.find((reg) => reg.cities.some((k) => k.key === c));
    if (r && !countries.includes(r.code)) { countries = [r.code]; regions.splice(0, regions.length, r); }
  }
  const primary = regions[0];
  const cityName = (key: string) => kb.regions.flatMap((r) => r.cities).find((c) => c.key === key)?.name[loc] ?? key;
  const place = cities.length ? cities.map(cityName).join(copy.and) : regions.map((r) => r.name[loc]).join(copy.and);

  // Goal.
  const goalAnswer = answers.goal ? Number(answers.goal) : NaN;
  const goal = ch.goal ?? (Number.isFinite(goalAnswer) && goalAnswer > 0 ? goalAnswer : x.goal ?? kb.defaults.goal);
  const goalStated = x.goal !== null || Number.isFinite(goalAnswer) || ch.goal !== undefined;

  // Client: exact match links automatically; a near match is confirmed by asking.
  const known = ctx.clients ?? [];
  let existing = x.clientName ? known.find((c) => normalize(c.name) === normalize(x.clientName!)) : undefined;
  const near = !existing && x.clientName ? known.find((c) => compact(c.name) === compact(x.clientName!) || distance(compact(c.name), compact(x.clientName!)) <= 2) : undefined;
  if (near && answers.client_confirm === "yes") existing = near;
  const placeholder = !x.clientName;
  const clientName = existing?.name ?? x.clientName ?? kb.defaults.placeholderClient[loc];
  const clientId = existing?.id ?? `c-${slug(clientName)}`;

  // Audience.
  let companyTypes = arch.companyTypes;
  const sectorAnswer = answers.public_sector && kb.questions.public_sector?.options.find((o) => o.id === answers.public_sector);
  if (sectorAnswer && sectorAnswer.companyTypes) companyTypes = sectorAnswer.companyTypes;
  const also = (ch.alsoArchetypes ?? []).map((k) => kb.archetypes.find((a) => a.key === k && !a.fallback)).filter((a): a is KnowledgeArchetype => Boolean(a) && a!.key !== arch.key);
  const audienceLabel = [(arch.fallback && (ch.audienceDescription ?? answers.audience_detail ?? x.audience)) || arch.label[loc], ...also.map((a) => a.label[loc])].join(" + ");
  const budgetAnswer = answers.min_budget ?? kb.questions.min_budget?.default;
  const budgetMin = budgetAnswer && budgetAnswer !== "none" ? Number(budgetAnswer) : 0;

  let sizeMin = individual ? undefined : arch.size?.min;
  let sizeMax = individual ? undefined : arch.size?.max;
  if (answers.company_size === "all") [sizeMin, sizeMax] = [undefined, undefined];
  const sizePreset = ch.sizePreset ? kb.sizePresets?.[ch.sizePreset] : undefined;
  if (sizePreset) [sizeMin, sizeMax] = [sizePreset.min ?? undefined, sizePreset.max ?? undefined];
  if (ch.sizeMin !== undefined) sizeMin = ch.sizeMin ?? undefined;
  if (ch.sizeMax !== undefined) sizeMax = ch.sizeMax ?? undefined;
  // Asking for bigger client books shrinks the market: widen the size band (unless the user set it).
  const minClients = ch.minClients;
  if (!individual && minClients !== undefined && minClients >= 5 && ch.sizeMax === undefined && (sizeMax ?? Infinity) < 100) {
    sizeMin = Math.max(10, sizeMin ?? 0);
    sizeMax = 100;
    notes.push(copy.widenedSize(sizeMin, sizeMax));
  }

  let titles = [...new Set([...(arch.titles.en.length ? arch.titles.en : ["Founder", "CEO"]), ...also.flatMap((a) => a.titles.en)])];
  if (also.length) companyTypes = { ar: [...new Set([...companyTypes.ar, ...also.flatMap((a) => a.companyTypes.ar)])], en: [...new Set([...companyTypes.en, ...also.flatMap((a) => a.companyTypes.en)])] };
  if (ch.decisionMakersOnly) {
    const senior = titles.filter((t) => (kb.seniorTitleKeywords ?? []).some((k) => t.toLowerCase().includes(k.toLowerCase())));
    titles = senior.length ? senior : kb.seniorTitleKeywords ?? titles;
  }

  const checkFor = (s: KnowledgeSignal): CriterionCheck | undefined => {
    switch (s.check) {
      case "size": return { type: "size", min: sizeMin, max: sizeMax };
      case "role": return { type: "role", titles };
      case "location": return { type: "location", countries, cities };
      case "budget": return { type: "budget", min: budgetMin };
      default: return undefined;
    }
  };
  const sizeText = (sizeMin !== undefined || sizeMax !== undefined) ? `${sizeMin ?? 1}–${sizeMax ?? "∞"}` : "";
  const labelOf = (s: KnowledgeSignal, lang: Locale = loc) => {
    let l = s.label[lang];
    if (s.param === "minClients") l = fill(l, { n: String(minClients ?? s.paramDefault ?? 3) });
    if (s.check === "size" && sizePreset) l = sizePreset.label[lang];
    else if (s.check === "size" && sizeText && (sizeMin !== arch.size?.min || sizeMax !== arch.size?.max)) l = l.replace(/\(?\d+\s*[–-]\s*\d+\)?|\(\d+\+\s*[^)]*\)/, `(${sizeText})`);
    return l;
  };
  const signals = arch.signals.filter((s) => !(s.check === "size" && sizeMin === undefined && sizeMax === undefined));
  const criteria: CampaignDraft["qualification"]["criteria"] = signals.map((s) => ({ label: labelOf(s), points: s.points, timing: s.timing, check: checkFor(s) }));
  const bilingual: Record<Locale, string>[] = signals.map((s) => ({ ar: labelOf(s, "ar"), en: labelOf(s, "en") }));
  if (minClients !== undefined && !arch.signals.some((s) => s.param === "minClients")) {
    criteria.push({ label: fill(kb.defaults.minClientsLabel?.[loc] ?? "{n}+", { n: String(minClients) }), points: 15 });
    bilingual.push({ ar: fill(kb.defaults.minClientsLabel?.ar ?? "{n}+", { n: String(minClients) }), en: fill(kb.defaults.minClientsLabel?.en ?? "{n}+", { n: String(minClients) }) });
  }
  const maxScore = criteria.reduce((sum, c) => sum + c.points, 0);
  const threshold = Math.max(1, Math.min(maxScore, ch.threshold ?? round5(maxScore * 0.75)));

  const marketLanguage: Locale = primary?.language ?? loc;
  const messageLanguage: Locale = ch.language ?? marketLanguage;
  const channels = {
    email: ch.channels?.email ?? true,
    linkedin: individual ? false : ch.channels?.linkedin ?? true,
    touches: 2 as const, waitDays: 3, language: messageLanguage, sendWindow: { startHour: 9, endHour: 18 },
  };
  if (!channels.email && !channels.linkedin) channels.email = true; // at least one channel
  const autonomy: AutonomyLevel = ch.autonomy ?? x.autonomy ?? "human_approval";

  const vars = {
    place, Place: cap(place), audience: audienceLabel, outcome: preset.plural[loc], short: arch.short[loc],
    country: primary?.name[loc] ?? place, focus: (primary?.focusCities ?? []).map(cityName).join(copy.and),
  };
  const campaignName = fill(arch.campaignName[loc], vars);
  const offerName = clientName;
  const offerCopy = kb.defaults.offer;

  const draft: CampaignDraft = {
    locale: loc,
    client: { id: clientId, name: clientName, market: countries[0], industry: arch.industry },
    campaign: { id: `k-${slug([arch.key, ...countries, ...cities, preset.key].join(" "))}`, name: campaignName, status: "active" },
    outcome: { preset: preset.key, goal },
    audience: {
      targetType: arch.targetType,
      countries,
      cities,
      companyTypes: companyTypes.en,
      sizeMin,
      sizeMax,
      sectors: [],
      titles,
      requireTitle: Boolean(ch.decisionMakersOnly || arch.requireTitle),
      traits: [],
    },
    offer: {
      name: offerName,
      valueProposition: offerCopy.valueProposition[messageLanguage],
      callToAction: x.cta ?? preset.conversion.cta[messageLanguage],
      mainMessage: fill((individual ? offerCopy.mainMessageIndividual : offerCopy.mainMessage)[messageLanguage], { company: "{{account.name}}", offer: offerName }),
      language: messageLanguage,
    },
    qualification: { criteria, threshold },
    channels,
    automation: { level: autonomy },
  };

  // Questions: at most two, the most important first. Anything the user already said is never asked.
  const qIds: string[] = [];
  if (near && !answers.client_confirm) qIds.push("client_confirm");
  if (!audienceKnown) qIds.push("audience_pick");
  if (!goalStated && !answers.goal) qIds.push("goal");
  if (!marketKnown && !answers.market) qIds.push("market");
  const archQ = arch.question;
  const archQAnswered =
    !archQ || archQ in answers || archQ === "audience_pick" ||
    (archQ === "media_kind" && Boolean(ch.audienceExplicit)) ||
    (archQ === "company_size" && Boolean(ch.sizePreset)) ||
    (archQ === "region_focus" && (x.cities.length > 0 || ch.cities !== undefined || !primary?.focusCities.length)) ||
    (archQ === "company_size" && (ch.sizeMin !== undefined || ch.sizeMax !== undefined || minClients !== undefined));
  if (archQ && !archQAnswered) qIds.push(archQ);
  const qVars = { ...vars, outcome: preset.plural[loc], unit: preset.unit[loc], existing: near?.name ?? "" };
  const questions: PlanQuestion[] = qIds.slice(0, 2).map((id) => {
    const q = kb.questions[id]!;
    return {
      id,
      text: fill(q.text[loc], qVars),
      // "Who should we target?" offers the audiences the agent knows; any other answer is taken as a description.
      options: q.effect === "archetype" && !q.options.length
        ? kb.archetypes.filter((a) => !a.fallback).map((a) => ({ id: a.key, label: a.label[loc], aliases: a.keywords }))
        : q.options.map((o) => ({ id: o.id, label: fill(o.label[loc], qVars), custom: o.custom, aliases: o.aliases })),
      custom: q.custom,
      default: q.default,
    };
  });

  // Assumptions: stated, never presented as facts; the user can change any of them by saying so.
  const status = opts.assumptionStatus ?? {};
  const assumptionTexts: [string, string][] = arch.assumptions[loc].map((t, i) => [`a${i + 1}`, t]);
  if (!x.outcome) assumptionTexts.push(["outcome", copy.outcomeAssumed(preset.label[loc])]);
  if (!marketKnown && !answers.market) assumptionTexts.push(["market", copy.marketAssumed(place)]);
  if (!goalStated) assumptionTexts.push(["goal", copy.goalAssumed(goal)]);
  if (placeholder) assumptionTexts.push(["client", copy.clientAssumed]);
  if (!ch.language) assumptionTexts.push(["language", copy.languageAssumed(copy.langName[messageLanguage])]);
  assumptionTexts.push(["offer", copy.offerAssumed]);
  const assumptions = assumptionTexts.map(([id, text]) => ({ id, text, status: status[id] ?? ("proposed" as const) }));

  const channelList = [channels.email && "email", channels.linkedin && "linkedin"].filter(Boolean) as string[];
  const sizeLabel = individual ? "" : sizePreset ? sizePreset.label[loc] : sizeMin === undefined && sizeMax === undefined ? (loc === "ar" ? "كل الأحجام" : "Any size") : loc === "ar" ? `${sizeMin ?? 1}–${sizeMax ?? "∞"} موظف` : `${sizeMin ?? 1}–${sizeMax ?? "∞"} employees`;
  const approval = { mode: ch.approval?.mode ?? ("manual" as const), autoAbove: ch.approval?.autoAbove ?? null };
  const kind = arch.fallback ? null : arch.kind ?? (individual ? "individuals" : "companies");
  const state: AgentCampaignState = {
    client: { id: clientId, name: placeholder ? null : clientName, existing: Boolean(existing) },
    outcome: { preset: preset.key, label: preset.label[loc], goal: goalStated ? goal : null },
    audience: {
      archetype: arch.fallback ? null : arch.key,
      kind,
      label: audienceKnown ? audienceLabel : null,
      description: arch.fallback ? (ch.audienceDescription ?? x.audience ?? null) : null,
      companyTypes: companyTypes[loc],
      titles: kind === "people" || ch.decisionMakersOnly ? titles : arch.titles[loc],
    },
    companySize: individual ? null : { min: sizeMin ?? null, max: sizeMax ?? null, label: sizeLabel },
    geography: { countries, cities, place },
    channels: channelList,
    language: messageLanguage,
    offer: { cta: draft.offer.callToAction },
    qualification: { threshold, maxScore, minClients: minClients ?? null, decisionMakersOnly: Boolean(ch.decisionMakersOnly), minBudget: individual ? budgetMin : null },
    approval,
    autonomy,
    provenance: {
      audience: ch.archetype !== undefined || ch.audienceDescription !== undefined || x.archetype || x.audience ? "user" : "default",
      companySize: ch.sizePreset || ch.sizeMin !== undefined || ch.sizeMax !== undefined || answers.company_size ? "user" : arch.size ? "inferred" : "default",
      geography: x.countries.length || ch.countries || ch.cities || answers.market ? "user" : "default",
      goal: goalStated ? "user" : "default",
      channels: ch.channels ? "user" : "default",
      language: ch.language ? "user" : "inferred",
      approval: ch.approval ? "user" : "default",
    },
  };
  return {
    version: 1,
    id: opts.id ?? `plan-${slug([clientName, arch.key, ...countries, preset.key].join(" "))}`,
    request: opts.request ?? "",
    locale: loc,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    understoodBy: opts.understoodBy ?? "rules",
    extraction: x,
    answers,
    changes: ch,
    notes,
    state,
    changeLog: opts.changeLog ?? [],
    status: questions.length ? "needs_input" : "ready",
    understanding: {
      client: { id: clientId, name: clientName, existing: Boolean(existing), placeholder },
      outcome: { preset: preset.key, label: preset.label[loc], plural: preset.plural[loc], goal, goalStated },
      market: { countries, cities, place },
      audience: { archetype: arch.key, label: audienceKnown ? audienceLabel : arch.label[loc], kind, companyTypes: companyTypes[loc], titles: state.audience.titles, needs: arch.needs?.[loc] ?? [] },
    },
    explanation: {
      understood: fill(arch.understood[loc], vars),
      research: arch.summarySignals[loc],
      why: copy.why(arch.summarySignals[loc].join(loc === "ar" ? "، " : ", ")),
      need: questions.map((q) => q.text),
    },
    assumptions,
    questions,
    strategy: {
      threshold,
      maxScore,
      signals: criteria.map((c, i) => ({ label: c.label, labels: bilingual[i] ?? { ar: c.label, en: c.label }, points: c.points, timing: Boolean(c.timing) })),
      channels: channelList.map((c) => CHANNEL_NAMES[c]?.[loc] ?? c),
      channelKeys: channelList,
      touches: channels.touches,
      waitDays: channels.waitDays,
      autonomy,
      messageLanguage,
      size: individual ? null : { min: sizeMin ?? null, max: sizeMax ?? null },
      minClients: minClients ?? null,
      decisionMakersOnly: Boolean(ch.decisionMakersOnly),
      sizeLabel,
      approval,
    },
    draft,
  };
}

const replan = (plan: CampaignPlan, ctx: PlannerContext, over: Partial<BuildPlanOptions>) =>
  buildPlan(plan.extraction, { ...ctx, locale: plan.locale }, {
    id: plan.id,
    request: plan.request,
    createdAt: plan.createdAt,
    understoodBy: plan.understoodBy,
    answers: plan.answers,
    changes: plan.changes,
    changeLog: plan.changeLog,
    assumptionStatus: Object.fromEntries(plan.assumptions.map((a) => [a.id, a.status])),
    ...over,
  });

/** Appends what changed in the state to the plan's change log. */
function logged(before: CampaignPlan | null, after: CampaignPlan, source: ChangeLogEntry["source"], messageId?: string): CampaignPlan {
  const rows = before ? diffPlans(before, after) : stateRows(after).filter((r) => r[2] !== "—").map(([key, label, value]) => ({ key, label, from: "—", to: value }));
  const at = new Date().toISOString();
  const log = [...(after.changeLog ?? [])];
  for (const r of rows) log.push({ n: log.length + 1, at, field: r.key, label: r.label, from: r.from, to: r.to, source, messageId });
  return { ...after, changeLog: log };
}

/** The first version of a plan, with its initial state in the change log. */
export function startPlan(extraction: GoalExtraction, ctx: PlannerContext, opts: BuildPlanOptions = {}, messageId?: string): CampaignPlan {
  return logged(null, buildPlan(extraction, ctx, opts), "initial", messageId);
}

/** One sentence → plan, deterministically. */
export function planFromRequest(request: string, ctx: PlannerContext, opts: BuildPlanOptions = {}): CampaignPlan {
  return logged(null, buildPlan(extractGoal(request, ctx), ctx, { ...opts, request }), "initial");
}

/** Records an answer and re-plans. No LLM call: the extraction is reused. */
export function applyAnswer(plan: CampaignPlan, questionId: string, value: string, ctx: PlannerContext, messageId?: string): CampaignPlan {
  const q = ctx.knowledge.questions[questionId];
  if (q?.effect === "archetype") {
    // "Who do we target?" — an audience the agent knows, or the user's own description.
    const known = ctx.knowledge.archetypes.find((a) => a.key === value && !a.fallback)?.key ?? extractGoal(value, ctx).archetype;
    const answered = { ...plan, answers: { ...plan.answers, [questionId]: value } };
    // Answering the people-vs-companies question settles the kind; picking an audience from the list doesn't.
    const settles = questionId !== "audience_pick";
    return applyChanges(answered, known ? { archetype: known, ...(settles ? { audienceExplicit: true } : {}) } : { audienceDescription: value }, ctx, messageId, "answer");
  }
  return logged(plan, replan(plan, ctx, { answers: { ...plan.answers, [questionId]: value } }), "answer", messageId);
}

/** Answers that were only about one audience. */
const AUDIENCE_ANSWERS = ["company_size", "public_sector", "min_budget", "media_kind", "region_focus"];

/** Applies conversational changes (add, replace, remove) and re-plans, keeping every earlier answer and change that still applies. */
export function applyChanges(plan: CampaignPlan, changes: PlanChanges, ctx: PlannerContext, messageId?: string, source: ChangeLogEntry["source"] = "message"): CampaignPlan {
  const current = plan.state?.audience.archetype ?? null;
  let answers = plan.answers;
  if (changes.archetype !== undefined && changes.archetype !== current) {
    answers = Object.fromEntries(Object.entries(plan.answers).filter(([k]) => !AUDIENCE_ANSWERS.includes(k) || (k === "media_kind" && changes.audienceExplicit)));
  }
  return logged(plan, replan(plan, ctx, { answers, changes: mergeChanges(plan.changes ?? {}, changes) }), source, messageId);
}

/** The state as labelled rows (for diffs, the change log and summaries). */
export function stateRows(p: CampaignPlan): [string, string, string][] {
  const loc = p.locale;
  const L = (a: string, e: string) => (loc === "ar" ? a : e);
  const st = p.state;
  const kindLabel = st.audience.kind === "people" ? L("أشخاص", "people") : st.audience.kind === "individuals" ? L("أفراد", "individuals") : st.audience.kind === "companies" ? L("شركات", "companies") : "";
  return [
    ["audience", L("الجمهور", "Audience"), st.audience.label ? `${st.audience.label}${kindLabel ? ` (${kindLabel})` : ""}` : L("غير محدد", "Not set")],
    ["market", L("الجغرافيا", "Geography"), st.geography.place],
    ["goal", L("الهدف", "Goal"), countOf(loc, p.understanding.outcome.goal, p.understanding.outcome.label, p.understanding.outcome.plural)],
    ["size", L("حجم الشركات", "Company size"), st.companySize?.label ?? "—"],
    ["minClients", L("الحد الأدنى للعملاء", "Minimum clients"), st.qualification.minClients ? `${st.qualification.minClients}+` : "—"],
    ["dm", L("أصحاب القرار فقط", "Decision makers only"), st.qualification.decisionMakersOnly ? L("نعم", "yes") : L("لا", "no")],
    ["threshold", L("حد التأهيل", "Qualification threshold"), `${st.qualification.threshold}/${st.qualification.maxScore}`],
    ["channels", L("القنوات", "Channels"), p.strategy.channels.join(" + ")],
    ["language", L("لغة الرسائل", "Message language"), COPY[loc].langName[st.language]],
    ["approval", L("اعتماد الرسائل", "Message approval"), st.approval.mode === "auto" ? L(`تلقائي للرسائل بدرجة ${st.approval.autoAbove}+`, `Automatic at ${st.approval.autoAbove}+`) : L("يدوي — كل رسالة بموافقتك", "Manual — you approve each")],
    ["autonomy", L("الإرسال", "Sending"), st.autonomy === "human_approval" ? L("بموافقتك فقط", "Only with your approval") : st.autonomy === "assisted" ? L("مساعد", "Assisted") : L("تلقائي", "Autonomous")],
  ];
}

/** Human-readable plan steps. */
export function planSteps(plan: CampaignPlan): { key: string; text: string }[] {
  const ar = plan.locale === "ar";
  const u = plan.understanding;
  const s = plan.strategy;
  const c = COPY[plan.locale];
  return [
    { key: "discover", text: ar ? `اكتشاف ${u.audience.label} في ${u.market.place}` : `Discover ${u.audience.label} in ${u.market.place}` },
    { key: "research", text: ar ? `دراسة كل جهة مع ذكر المصدر: ${plan.explanation.research.join("، ")}` : `Research each prospect with sources: ${plan.explanation.research.join(", ")}` },
    { key: "score", text: c.threshold(s.threshold, s.maxScore) },
    { key: "personalize", text: ar ? "تخصيص رسالة لكل جهة مناسبة" : "Personalize a message for each fit prospect" },
    { key: "outreach", text: c.channels(s.channels.join(c.and), s.touches, s.waitDays) },
    { key: "approval", text: s.autonomy === "human_approval" ? c.approval : s.autonomy === "assisted" ? c.approvalAssisted : c.approvalAuto },
    { key: "outcome", text: ar ? `متابعة الردود وتأهيلها حتى ${countOf("ar", u.outcome.goal, u.outcome.label, u.outcome.plural)}` : `Handle replies and qualify toward ${countOf("en", u.outcome.goal, u.outcome.label, u.outcome.plural)}` },
  ];
}

/** Human-readable differences between two versions of a plan (state field by field). */
export function diffPlans(before: CampaignPlan, after: CampaignPlan): { key: string; label: string; from: string; to: string }[] {
  const old = new Map(stateRows(before).map(([k, , v]) => [k, v]));
  return stateRows(after).map(([key, label, to]) => ({ key, label, from: old.get(key) ?? "—", to })).filter((r) => r.from !== r.to);
}
