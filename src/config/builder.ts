import type { Milestone } from "./actions.js";
import type { AutonomyLevel } from "./actions.js";
import { parseCampaignConfig } from "./validate.js";
import type { Rule } from "./rules.js";
import type { CampaignConfig, CampaignConfigInput } from "./schema.js";

/**
 * Campaign builder: turns the answers of the friendly setup flow into a full,
 * validated campaign config. Outcome types come from presets (data), so the
 * builder itself knows nothing about specific outcomes, clients or industries.
 */

export type Locale = "ar" | "en";
type Text = Record<Locale, string>;

export interface OutcomePreset {
  key: string;
  custom?: boolean;
  label: Text;
  plural: Text;
  unit: Text;
  description: Text;
  example: Text;
  /** Business event that confirms the outcome. */
  achievedEvent: string;
  valueFromEvent?: string;
  requiresQualification: boolean;
  stages: { key: string; label: Text; milestone?: Milestone; onEvent?: string }[];
  appointments?: { label: Text; singular: Text; events: { booked: string; held: string; cancelled?: string; noShow?: string } };
  conversion: { cta: Text; subject: Text; body: Text };
}

/** How a qualification criterion is checked. */
export type CriterionCheck =
  | { type: "research" } // researched per prospect; counts only with a cited source
  | { type: "size"; min?: number; max?: number }
  | { type: "role"; titles: string[] }
  | { type: "location"; countries?: string[]; cities?: string[] }
  | { type: "budget"; min: number };

export interface CampaignDraft {
  locale: Locale;
  client: { id: string; name: string; company?: string; industry?: string; market?: string; description?: string; timezone?: string };
  campaign: { id: string; name: string; status?: "draft" | "active"; periodStart?: string };
  outcome: {
    preset: string;
    goal: number;
    /** For custom outcomes. */
    customLabel?: string;
    customUnit?: string;
    value?: { amount: number; currency: string; recurrence?: "one_time" | "monthly" | "annual" };
  };
  audience: {
    /** Companies (default) or individuals (buyers, investors, consumers). */
    targetType?: "account" | "individual";
    countries: string[];
    companyTypes: string[];
    sizeMin?: number;
    sizeMax?: number;
    sectors: string[];
    cities: string[];
    titles: string[];
    traits: string[];
    advanced?: { growthSignals?: string[]; technologies?: string[]; customFilters?: string };
  };
  offer: { name: string; valueProposition: string; callToAction: string; mainMessage: string; link?: string; language: Locale; pricing?: string };
  qualification: {
    criteria: { label: string; points: number; timing?: boolean; check?: CriterionCheck }[];
    threshold: number;
    /** Require a positive reply before the conversion step (default true). */
    requirePositiveReply?: boolean;
  };
  channels: { email: boolean; linkedin: boolean; touches: 1 | 2; waitDays: number; language: Locale; sendWindow: { startHour: number; endHour: number } };
  automation: { level: AutonomyLevel };
}

const TIMEZONES: Record<string, string> = { SA: "Asia/Riyadh", AE: "Asia/Dubai", KW: "Asia/Kuwait", QA: "Asia/Qatar", BH: "Asia/Bahrain", OM: "Asia/Muscat", EG: "Africa/Cairo", JO: "Asia/Amman" };

const COPY: Record<Locale, {
  greeting: string; fallbackName: string; followUp: string; answer: string; ack: string;
  escalateCommercial: string; escalateComplaint: string; tiers: [string, string, string];
  positiveReply: string; scoreAtLeast: (n: number) => string; researchPrompt: (label: string) => string;
}> = {
  en: {
    greeting: "Hi", fallbackName: "there",
    followUp: "Hi {{contact.firstName | \"there\"}}, following up on my note about {{offer.name}} — {{offer.valueProposition}}",
    answer: "Thanks for the question, {{contact.firstName | \"there\"}}. Short answer: {{offer.valueProposition}} I'll follow up with details.",
    ack: "Thank you {{contact.firstName | \"\"}} — happy to find a time. I'll send a link shortly.",
    escalateCommercial: "Commercial negotiation — needs a human.", escalateComplaint: "Complaint or compliance mention.",
    tiers: ["High fit", "Medium fit", "Low fit"],
    positiveReply: "Replied positively", scoreAtLeast: (n) => `Fit score ≥ ${n}`, researchPrompt: (l) => `Is this true, with a source: ${l}?`,
  },
  ar: {
    greeting: "مرحباً", fallbackName: "",
    followUp: "مرحباً {{contact.firstName | \"\"}}، أتابع رسالتي السابقة عن {{offer.name}} — {{offer.valueProposition}}",
    answer: "شكراً على سؤالك {{contact.firstName | \"\"}}. باختصار: {{offer.valueProposition}} وسأرسل لك التفاصيل قريباً.",
    ack: "شكراً لك {{contact.firstName | \"\"}} — يسعدنا تحديد موعد، وسأرسل لك الرابط قريباً.",
    escalateCommercial: "تفاوض تجاري — يحتاج شخصاً.", escalateComplaint: "شكوى أو إشارة قانونية.",
    tiers: ["ملاءمة عالية", "ملاءمة متوسطة", "ملاءمة منخفضة"],
    positiveReply: "ردّ بإيجابية", scoreAtLeast: (n) => `درجة الملاءمة ≥ ${n}`, researchPrompt: (l) => `هل ينطبق هذا مع ذكر المصدر: ${l}؟`,
  },
};

export interface IntentPreset {
  key: string;
  label: Text;
  sentiment: "positive" | "neutral" | "negative";
  keywords: string[];
  appointmentsOnly?: boolean;
  milestone?: Milestone;
  stopSequence?: boolean;
  respondWith?: string;
  suppress?: boolean;
}

/** Presets are data (see presets/*.json): outcome types and the reply-intent catalog. */
export interface BuilderPresets {
  outcomes: OutcomePreset[];
  intents: IntentPreset[];
}

function criterionRule(c: CampaignDraft["qualification"]["criteria"][number], key: string, individual: boolean): Rule {
  const check = c.check ?? { type: "research" };
  switch (check.type) {
    case "size":
      return { field: "account.employees", op: "between", value: [check.min ?? 0, check.max ?? 1_000_000] };
    case "role":
      return { field: "contact.title", op: "containsAny", value: check.titles };
    case "location":
      return check.cities?.length
        ? { field: individual ? "contact.city" : "account.city", op: "in", value: check.cities }
        : { field: individual ? "contact.country" : "account.country", op: "in", value: check.countries ?? [] };
    case "budget":
      return { field: "attributes.budget", op: "gte", value: check.min };
    case "research":
      return { field: `research.${key}`, op: "exists" };
  }
}

export function buildCampaignConfig(draft: CampaignDraft, presets: BuilderPresets): CampaignConfig {
  const preset = presets.outcomes.find((p) => p.key === draft.outcome.preset);
  if (!preset) throw new Error(`unknown outcome preset '${draft.outcome.preset}'`);
  const loc = draft.locale;
  const copy = COPY[loc];
  const msgLang = draft.offer.language;
  const msg = COPY[msgLang];
  const a = draft.audience;
  const q = draft.qualification;

  const outcomeKey = preset.custom ? "custom_outcome" : preset.key;
  const outcomeLabel = preset.custom && draft.outcome.customLabel ? draft.outcome.customLabel : preset.label[loc];
  const unit = preset.custom && draft.outcome.customUnit ? draft.outcome.customUnit : preset.unit[loc];
  const criterionKey = (i: number) => `criterion_${i + 1}`;

  const fit: Rule[] = [];
  const individual = a.targetType === "individual";
  const geo = individual ? "contact" : "account";
  if (a.cities.length) fit.push({ field: `${geo}.city`, op: "in", value: a.cities });
  else if (a.countries.length) fit.push({ field: `${geo}.country`, op: "in", value: a.countries });
  if (!individual && (a.sizeMin !== undefined || a.sizeMax !== undefined)) fit.push({ field: "account.employees", op: "between", value: [a.sizeMin ?? 0, a.sizeMax ?? 1_000_000] });

  const researchQuestions = q.criteria
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (c.check?.type ?? "research") === "research")
    .map(({ c, i }) => ({ key: criterionKey(i), prompt: copy.researchPrompt(c.label), required: false }));

  const maxPoints = q.criteria.reduce((s, c) => s + Math.max(0, c.points), 0);
  const threshold = Math.min(q.threshold, maxPoints);
  const channels = [
    ...(draft.channels.email ? [{ key: "email", handle: "email" }] : []),
    ...(draft.channels.linkedin ? [{ key: "linkedin", handle: "linkedin" }] : []),
  ];
  if (!channels.length) throw new Error("enable at least one channel");
  const first = channels[0]!.key;
  const quiet = { startHour: draft.channels.sendWindow.endHour % 24, endHour: draft.channels.sendWindow.startHour % 24 };
  const greeting = `${msg.greeting} {{contact.firstName | "${msg.fallbackName}"}}`;
  const ctaLine = draft.offer.link ? `${draft.offer.callToAction}: ${draft.offer.link}` : draft.offer.callToAction;

  const input: CampaignConfigInput = {
    version: 1,
    client: {
      id: draft.client.id,
      name: draft.client.name,
      industry: draft.client.industry,
      timezone: draft.client.timezone ?? TIMEZONES[a.countries[0] ?? ""] ?? "UTC",
    },
    campaign: {
      id: draft.campaign.id,
      name: draft.campaign.name,
      status: draft.campaign.status ?? "draft",
      description: [a.companyTypes.join(", "), a.countries.join(", ")].filter(Boolean).join(" · ") || undefined,
      period: draft.campaign.periodStart ? { start: draft.campaign.periodStart } : undefined,
    },
    outcome: {
      key: outcomeKey,
      label: outcomeLabel,
      unit,
      description: preset.description[loc],
      achievedWhen: { field: "event.type", op: "eq", value: preset.achievedEvent },
      requiresQualification: preset.requiresQualification,
      target: { count: draft.outcome.goal },
      value: draft.outcome.value
        ? { amount: draft.outcome.value.amount, currency: draft.outcome.value.currency, recurrence: draft.outcome.value.recurrence ?? "one_time", fromField: preset.valueFromEvent }
        : undefined,
      conversionStep: { template: "conversion" },
    },
    appointments: preset.appointments
      ? { label: preset.appointments.label[loc], singular: preset.appointments.singular[loc], events: preset.appointments.events }
      : undefined,
    icp: {
      description: [a.companyTypes.join(", "), a.sectors.join(", "), a.traits.join(", ")].filter(Boolean).join(" · ") || undefined,
      targetType: individual ? "individual" : "account",
      personas: a.titles.length ? [{ key: "target_role", label: a.titles.join(" / "), match: { field: "contact.title", op: "containsAny", value: a.titles } }] : [],
      fit: fit.length ? { all: fit } : { always: true },
    },
    market: { geographies: [...a.countries, ...a.cities], languages: [draft.channels.language], segments: [...a.companyTypes, ...a.sectors] },
    offer: {
      name: draft.offer.name,
      valueProposition: draft.offer.valueProposition,
      callToAction: draft.offer.callToAction,
      pricing: draft.offer.pricing,
      link: draft.offer.link,
      proofPoints: [],
    },
    discovery: {
      source: "default",
      query: {
        countries: a.countries, cities: a.cities, companyTypes: a.companyTypes, sectors: a.sectors, titles: a.titles,
        sizeMin: a.sizeMin, sizeMax: a.sizeMax, traits: a.traits, ...a.advanced,
      },
    },
    research: { provider: "default", questions: researchQuestions },
    contacts: { finder: "default" },
    scoring: {
      scale: "points",
      signals: q.criteria.map((c, i) => ({
        key: criterionKey(i), label: c.label, weight: c.points, category: c.timing ? "timing" : "fit", when: criterionRule(c, criterionKey(i), individual),
      })),
      tiers: [
        { key: "a", label: copy.tiers[0], min: threshold },
        { key: "b", label: copy.tiers[1], min: Math.round(threshold * 0.6) },
        { key: "c", label: copy.tiers[2], min: 0 },
      ],
    },
    qualification: {
      framework: "builder",
      criteria: [
        ...(q.requirePositiveReply !== false
          ? [{ key: "positive_reply", label: copy.positiveReply, required: true, when: { field: "engagement.lastIntent", op: "in", value: ["interested", "question", "meeting_request"] } as Rule }]
          : []),
        { key: "fit_score", label: copy.scoreAtLeast(threshold), required: true, when: { field: "prospect.score", op: "gte", value: threshold } as Rule },
      ],
      minCriteriaMet: q.requirePositiveReply !== false ? 2 : 1,
    },
    funnel: {
      stages: preset.stages.map((s) => ({
        key: s.key, label: s.label[loc], milestone: s.milestone,
        onEvent: s.onEvent ? { field: "event.type", op: "eq", value: s.onEvent } : undefined,
      })),
    },
    personalization: {
      tone: "clear, respectful",
      language: msgLang,
      templates: {
        intro: { subject: draft.offer.name, body: `${greeting},\n${draft.offer.mainMessage}\n${ctaLine}` },
        follow_up: { body: msg.followUp },
        conversion: { subject: preset.conversion.subject[msgLang], body: preset.conversion.body[msgLang] },
        answer_question: { body: msg.answer },
        ...(preset.appointments ? { appointment_ack: { body: msg.ack } } : {}),
      },
    },
    outreach: {
      channels,
      sequence: [
        { key: "s1_intro", channel: first, dayOffset: 0, template: "intro" },
        ...(draft.channels.touches === 2 ? [{ key: "s2_follow_up", channel: "auto", dayOffset: draft.channels.waitDays, template: "follow_up" }] : []),
      ],
      minScore: threshold,
    },
    replies: {
      intents: presets.intents
        .filter((i) => !i.appointmentsOnly || preset.appointments)
        .map(({ appointmentsOnly: _skip, label, ...i }) => ({ ...i, label: label[msgLang] })),
      defaultIntent: "other",
      minClassificationConfidence: 0.6,
    },
    autonomy: { level: draft.automation.level },
    constraints: {
      quietHours: quiet.startHour === quiet.endHour ? undefined : quiet,
      maxTouchesPerProspect: draft.channels.touches,
      minHoursBetweenTouches: Math.max(24, draft.channels.waitDays * 24),
      rateLimits: [
        ...(draft.channels.email ? [{ action: ["send_message", "follow_up"] as const, channel: "email", perDay: 50, perHour: 12 }] : []),
        ...(draft.channels.linkedin ? [{ action: ["send_message", "follow_up"] as const, channel: "linkedin", perDay: 20 }] : []),
      ].map((r) => ({ ...r, action: [...r.action] })),
    },
    escalation: {
      rules: [
        { key: "commercial", when: { field: "reply.text", op: "containsAny", value: ["discount", "contract", "invoice", "خصم", "عقد", "فاتورة"] }, severity: "medium", reason: copy.escalateCommercial },
        { key: "complaint", when: { field: "reply.text", op: "containsAny", value: ["spam", "complaint", "legal", "شكوى", "قانوني", "مزعج"] }, severity: "high", reason: copy.escalateComplaint },
      ],
    },
    analytics: {
      dimensions: [
        { key: "geography", label: loc === "ar" ? "المدينة" : "City", field: `${geo}.city` },
        { key: "persona", label: loc === "ar" ? "نوع الشخص" : "Persona", field: "prospect.persona" },
        { key: "tier", label: loc === "ar" ? "فئة الملاءمة" : "Fit tier", field: "prospect.tier" },
      ],
    },
  };
  return parseCampaignConfig(input, `builder:${draft.campaign.id}`);
}
