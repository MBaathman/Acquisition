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
  budgetOptions?: number[];
  budgetCurrency?: string;
  industry?: string;
  /** Name fragments for fictional simulated prospects. */
  namePool?: { a: string[]; b: string[] };
}

export interface KnowledgeQuestion {
  text: Text;
  effect: "goal" | "country" | "cities" | "companyTypes" | "budget" | "audience";
  options: { id: string; label: Text; custom?: string; companyTypes?: Record<Locale, string[]> | null }[];
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
  };
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
  options: { id: string; label: string; custom?: string }[];
  custom?: string;
  default?: string;
}

export interface PlanAssumption {
  id: string;
  text: string;
  status: "proposed" | "accepted" | "edited";
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
  status: "needs_input" | "ready" | "approved";
  understanding: {
    client: { id: string; name: string; existing: boolean; placeholder: boolean };
    outcome: { preset: string; label: string; plural: string; goal: number; goalStated: boolean };
    market: { countries: string[]; cities: string[]; place: string };
    audience: { archetype: string; label: string; companyTypes: string[]; titles: string[]; needs: string[] };
  };
  explanation: { understood: string; research: string[]; why: string; need: string[] };
  assumptions: PlanAssumption[];
  questions: PlanQuestion[];
  strategy: {
    threshold: number;
    maxScore: number;
    signals: { label: string; points: number; timing: boolean }[];
    channels: string[];
    touches: number;
    waitDays: number;
    autonomy: AutonomyLevel;
    messageLanguage: Locale;
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

const COPY: Record<Locale, {
  why: (signals: string) => string;
  goalAssumed: (n: number) => string;
  marketAssumed: (place: string) => string;
  outcomeAssumed: (label: string) => string;
  clientAssumed: string;
  offerAssumed: string;
  approval: string;
  channels: (list: string, touches: number, days: number) => string;
  threshold: (t: number, max: number) => string;
  and: string;
}> = {
  ar: {
    why: (s) => `اخترت هذه الإشارات لأنها الأقرب لتحقيق النتيجة: ${s}.`,
    goalAssumed: (n) => `الهدف ${n} (لم يُذكر رقم)`,
    marketAssumed: (p) => `السوق: ${p}`,
    outcomeAssumed: (l) => `نوع النتيجة: ${l}`,
    clientAssumed: "العميل غير محدد — سننشئ عميلاً جديداً وتعدّل اسمه لاحقاً",
    offerAssumed: "سأكتب العرض من وصف العميل — عدّله من إعدادات الحملة",
    approval: "كل رسالة خارجية تنتظر موافقتك قبل الإرسال",
    channels: (l, t, d) => `التواصل عبر ${l}، ${t === 2 ? "رسالتان" : "رسالة واحدة"} بينهما ${d} أيام`,
    threshold: (t, m) => `نتواصل فقط مع من تتجاوز درجته ${t} من ${m}`,
    and: " و",
  },
  en: {
    why: (s) => `I picked these signals because they best predict the outcome: ${s}.`,
    goalAssumed: (n) => `Goal of ${n} (no number was given)`,
    marketAssumed: (p) => `Market: ${p}`,
    outcomeAssumed: (l) => `Outcome type: ${l}`,
    clientAssumed: "No client named — I'll create a new one you can rename",
    offerAssumed: "I'll write the offer from the client description — edit it in campaign settings",
    approval: "Every outbound message waits for your approval",
    channels: (l, t, d) => `Reach out by ${l}, ${t} touch${t === 2 ? "es" : ""} ${d} days apart`,
    threshold: (t, m) => `Only contact prospects scoring ${t}+ out of ${m}`,
    and: " and ",
  },
};

const CHANNEL_NAMES: Record<string, Text> = { email: { ar: "البريد", en: "email" }, linkedin: { ar: "LinkedIn", en: "LinkedIn" } };

export interface BuildPlanOptions {
  id?: string;
  request?: string;
  createdAt?: string;
  understoodBy?: "rules" | "llm";
  answers?: Record<string, string>;
  assumptionStatus?: Record<string, PlanAssumption["status"]>;
}

export function buildPlan(extraction: GoalExtraction, ctx: PlannerContext, opts: BuildPlanOptions = {}): CampaignPlan {
  const kb = ctx.knowledge;
  const loc = ctx.locale;
  const copy = COPY[loc];
  const answers = { ...(opts.answers ?? {}) };
  const x = extraction;

  const arch = kb.archetypes.find((a) => a.key === x.archetype) ?? kb.archetypes.find((a) => a.fallback)!;
  const preset = ctx.outcomes.find((o) => o.key === (x.outcome ?? kb.defaults.outcome)) ?? ctx.outcomes[0]!;

  // Market (answers override the request).
  let countries = x.countries.length ? [...x.countries] : [];
  if (answers.market) countries = [answers.market];
  const marketKnown = countries.length > 0;
  if (!marketKnown) countries = [kb.defaults.country];
  const regions = countries.map((c) => kb.regions.find((r) => r.code === c)).filter((r): r is KnowledgeRegion => Boolean(r));
  const primary = regions[0];
  let cities = [...x.cities];
  if (answers.region_focus === "focus" && primary) cities = [...primary.focusCities];
  else if (answers.region_focus === "all") cities = [];
  else if (answers.region_focus && !["focus", "all", "custom"].includes(answers.region_focus)) cities = answers.region_focus.split(",").map((s) => s.trim()).filter(Boolean);
  const cityName = (key: string) => regions.flatMap((r) => r.cities).find((c) => c.key === key)?.name[loc] ?? key;
  const place = cities.length ? cities.map(cityName).join(copy.and) : regions.map((r) => r.name[loc]).join(copy.and);

  // Goal.
  const goalAnswer = answers.goal ? Number(answers.goal) : NaN;
  const goal = Number.isFinite(goalAnswer) && goalAnswer > 0 ? goalAnswer : x.goal ?? kb.defaults.goal;
  const goalStated = x.goal !== null || Number.isFinite(goalAnswer);

  // Client.
  const existing = x.clientName ? (ctx.clients ?? []).find((c) => normalize(c.name) === normalize(x.clientName!)) : undefined;
  const placeholder = !x.clientName;
  const clientName = existing?.name ?? x.clientName ?? kb.defaults.placeholderClient[loc];
  const clientId = existing?.id ?? `c-${slug(clientName)}`;

  // Audience.
  let companyTypes = arch.companyTypes;
  const sectorAnswer = answers.public_sector && kb.questions.public_sector?.options.find((o) => o.id === answers.public_sector);
  if (sectorAnswer && sectorAnswer.companyTypes) companyTypes = sectorAnswer.companyTypes;
  const audienceLabel = answers.audience_detail || (arch.fallback && x.audience) || arch.label[loc];
  const budgetAnswer = answers.min_budget ?? kb.questions.min_budget?.default;
  const budgetMin = budgetAnswer && budgetAnswer !== "none" ? Number(budgetAnswer) : 0;

  const checkFor = (s: KnowledgeSignal): CriterionCheck | undefined => {
    switch (s.check) {
      case "size": return { type: "size", min: arch.size?.min, max: arch.size?.max };
      case "role": return { type: "role", titles: arch.titles.en.length ? arch.titles.en : ["Founder", "CEO"] };
      case "location": return { type: "location", countries, cities };
      case "budget": return { type: "budget", min: budgetMin };
      default: return undefined;
    }
  };
  const criteria = arch.signals.map((s) => ({ label: s.label[loc], points: s.points, timing: s.timing, check: checkFor(s) }));
  const maxScore = criteria.reduce((sum, c) => sum + c.points, 0);
  const threshold = Math.min(maxScore, round5(maxScore * 0.75));

  const messageLanguage: Locale = primary?.language ?? loc;
  const individual = arch.targetType === "individual";
  const channels = { email: true, linkedin: !individual, touches: 2 as const, waitDays: 3, language: messageLanguage, sendWindow: { startHour: 9, endHour: 18 } };
  const autonomy: AutonomyLevel = x.autonomy ?? "human_approval";

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
      sizeMin: individual ? undefined : arch.size?.min,
      sizeMax: individual ? undefined : arch.size?.max,
      sectors: [],
      titles: arch.titles.en,
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

  // Questions: at most two, the most important first.
  const qIds: string[] = [];
  if (!goalStated && !answers.goal) qIds.push("goal");
  if (!marketKnown && !answers.market) qIds.push("market");
  const archQ = arch.question;
  const archQNeeded = archQ && !(archQ in answers) && !(archQ === "region_focus" && (x.cities.length > 0 || !primary?.focusCities.length));
  if (archQ && archQNeeded) qIds.push(archQ);
  const questions: PlanQuestion[] = qIds.slice(0, 2).map((id) => {
    const q = kb.questions[id]!;
    const qVars = { ...vars, outcome: preset.plural[loc], unit: preset.unit[loc] };
    return {
      id,
      text: fill(q.text[loc], qVars),
      options: q.options.map((o) => ({ id: o.id, label: fill(o.label[loc], qVars), custom: o.custom })),
      custom: q.custom,
      default: q.default,
    };
  });

  // Assumptions the user can accept or edit (never presented as facts).
  const status = opts.assumptionStatus ?? {};
  const assumptionTexts: [string, string][] = arch.assumptions[loc].map((t, i) => [`a${i + 1}`, t]);
  if (!x.outcome) assumptionTexts.push(["outcome", copy.outcomeAssumed(preset.label[loc])]);
  if (!marketKnown && !answers.market) assumptionTexts.push(["market", copy.marketAssumed(place)]);
  if (!goalStated) assumptionTexts.push(["goal", copy.goalAssumed(goal)]);
  if (placeholder) assumptionTexts.push(["client", copy.clientAssumed]);
  assumptionTexts.push(["offer", copy.offerAssumed]);
  const assumptions = assumptionTexts.map(([id, text]) => ({ id, text, status: status[id] ?? ("proposed" as const) }));

  const channelList = [channels.email && "email", channels.linkedin && "linkedin"].filter(Boolean) as string[];
  return {
    version: 1,
    id: opts.id ?? `plan-${slug([clientName, arch.key, ...countries, preset.key].join(" "))}`,
    request: opts.request ?? "",
    locale: loc,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    understoodBy: opts.understoodBy ?? "rules",
    extraction: x,
    answers,
    status: questions.length ? "needs_input" : "ready",
    understanding: {
      client: { id: clientId, name: clientName, existing: Boolean(existing), placeholder },
      outcome: { preset: preset.key, label: preset.label[loc], plural: preset.plural[loc], goal, goalStated },
      market: { countries, cities, place },
      audience: { archetype: arch.key, label: audienceLabel, companyTypes: companyTypes[loc], titles: arch.titles[loc], needs: arch.needs?.[loc] ?? [] },
    },
    explanation: {
      understood: fill(arch.understood[loc], vars),
      research: arch.summarySignals[loc],
      why: copy.why(arch.summarySignals[loc].join("، ")),
      need: questions.map((q) => q.text),
    },
    assumptions,
    questions,
    strategy: {
      threshold,
      maxScore,
      signals: criteria.map((c) => ({ label: c.label, points: c.points, timing: Boolean(c.timing) })),
      channels: channelList.map((c) => CHANNEL_NAMES[c]?.[loc] ?? c),
      touches: channels.touches,
      waitDays: channels.waitDays,
      autonomy,
      messageLanguage,
    },
    draft,
  };
}

/** One sentence → plan, deterministically. */
export function planFromRequest(request: string, ctx: PlannerContext, opts: BuildPlanOptions = {}): CampaignPlan {
  return buildPlan(extractGoal(request, ctx), ctx, { ...opts, request });
}

/** Records an answer and re-plans. No LLM call: the extraction is reused. */
export function applyAnswer(plan: CampaignPlan, questionId: string, value: string, ctx: PlannerContext): CampaignPlan {
  return buildPlan(plan.extraction, { ...ctx, locale: plan.locale }, {
    id: plan.id,
    request: plan.request,
    createdAt: plan.createdAt,
    understoodBy: plan.understoodBy,
    answers: { ...plan.answers, [questionId]: value },
    assumptionStatus: Object.fromEntries(plan.assumptions.map((a) => [a.id, a.status])),
  });
}

/** Human-readable plan steps (shown as "the plan" and as the progress checklist). */
export function planSteps(plan: CampaignPlan): { key: string; text: string }[] {
  const ar = plan.locale === "ar";
  const u = plan.understanding;
  const s = plan.strategy;
  return [
    { key: "discover", text: ar ? `اكتشاف ${u.audience.label} في ${u.market.place}` : `Discover ${u.audience.label} in ${u.market.place}` },
    { key: "research", text: ar ? `دراسة كل جهة مع ذكر المصدر: ${plan.explanation.research.join("، ")}` : `Research each prospect with sources: ${plan.explanation.research.join(", ")}` },
    { key: "score", text: COPY[plan.locale].threshold(s.threshold, s.maxScore) },
    { key: "personalize", text: ar ? "تخصيص رسالة لكل جهة مناسبة" : "Personalize a message for each fit prospect" },
    { key: "outreach", text: COPY[plan.locale].channels(s.channels.join(COPY[plan.locale].and), s.touches, s.waitDays) },
    { key: "approval", text: COPY[plan.locale].approval },
    { key: "outcome", text: ar ? `متابعة الردود وتأهيلها حتى ${u.outcome.goal} ${u.outcome.plural}` : `Handle replies and qualify toward ${u.outcome.goal} ${u.outcome.plural}` },
  ];
}
