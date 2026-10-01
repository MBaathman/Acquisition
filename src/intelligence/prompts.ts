import * as z from "zod/v4";
import type { Effort } from "./types.js";

/**
 * Prompt registry: every model prompt in the product lives here, versioned,
 * with the JSON schema its answer must satisfy. Bump `version` whenever the
 * text or schema changes — cached answers are keyed by it.
 *
 * The LLM is used only where language or judgment is needed:
 *   understand_goal     — a request the rules could not fully understand
 *   classify_reply      — an inbound reply (keyword rules as fallback)
 *   personalize_message — rewriting a rendered template from sourced facts
 * Navigation, viewing, filtering and reporting never call a model.
 */

export interface PromptDef<I, O> {
  id: string;
  version: number;
  purpose: string;
  system: string;
  render(input: I): string;
  output: z.ZodType<O>;
  maxTokens: number;
  effort: Effort;
}

const definePrompt = <I, O>(p: PromptDef<I, O>) => p;
const json = (v: unknown) => JSON.stringify(v, null, 1);

// ---------------------------------------------------------------- understand_goal

export const GoalExtractionSchema = z.object({
  clientName: z.string().nullable(),
  outcome: z.string().nullable(),
  goal: z.number().nullable(),
  countries: z.array(z.string()),
  cities: z.array(z.string()),
  archetype: z.string().nullable(),
  audience: z.string().nullable(),
  cta: z.string().nullable(),
  autonomy: z.enum(["human_approval", "assisted", "autonomous"]).nullable(),
});

export interface UnderstandGoalInput {
  request: string;
  locale: string;
  outcomes: { key: string; label: string }[];
  regions: { code: string; name: string; cities: string[] }[];
  archetypes: { key: string; label: string }[];
  clients: string[];
}

export const understandGoal = definePrompt<UnderstandGoalInput, z.infer<typeof GoalExtractionSchema>>({
  id: "understand_goal",
  version: 1,
  purpose: "Turn one sentence describing a business goal into structured campaign fields.",
  system: [
    "You turn a business owner's one-sentence acquisition goal into structured fields for an acquisition engine.",
    "Use only the keys listed in the catalog for outcome, countries, cities and archetype; use null or an empty list when the sentence does not say.",
    "Never invent a client name, number or market that is not in the sentence. Existing clients are listed; prefer an exact existing name when one is meant.",
    "`audience` is a short description of who to reach, in the sentence's language, only when no archetype fits.",
    "`cta` is the offer the sentence mentions (e.g. a free trial), else null. `autonomy` only if the sentence asks for it explicitly.",
  ].join("\n"),
  render: (i) => `Catalog:\n${json({ outcomes: i.outcomes, regions: i.regions, archetypes: i.archetypes, existingClients: i.clients })}\n\nSentence (${i.locale}):\n${i.request}`,
  output: GoalExtractionSchema,
  maxTokens: 2000,
  effort: "low",
});

// ---------------------------------------------------------------- classify_reply

export const ReplyClassificationSchema = z.object({
  intent: z.string(),
  confidence: z.number(),
  extracted: z.array(z.object({ key: z.string(), value: z.string() })),
});

export interface ClassifyReplyInput {
  text: string;
  intents: { key: string; label: string; sentiment: string }[];
  defaultIntent: string;
}

export const classifyReply = definePrompt<ClassifyReplyInput, z.infer<typeof ReplyClassificationSchema>>({
  id: "classify_reply",
  version: 1,
  purpose: "Classify an inbound reply to outreach into one of the campaign's intents.",
  system: [
    "Classify a prospect's reply to a sales outreach message into exactly one intent key from the list.",
    "confidence is your calibrated probability (0..1) that the intent is right; use below 0.6 when the reply is ambiguous or mixes intents.",
    "extracted holds facts stated in the reply only (e.g. budget, timeline, team size), as key/value strings; empty when none.",
    "If nothing fits, use the default intent.",
  ].join("\n"),
  render: (i) => `Intents:\n${json(i.intents)}\nDefault intent: ${i.defaultIntent}\n\nReply:\n${i.text}`,
  output: ReplyClassificationSchema,
  maxTokens: 1500,
  effort: "low",
});

// ---------------------------------------------------------------- personalize_message

export const PersonalizedMessageSchema = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  confidence: z.number(),
});

export interface PersonalizeInput {
  language: string;
  rendered: { subject?: string; body: string };
  facts: { label: string; value: string; source?: string }[];
  offer: { name: string; valueProposition: string; callToAction: string };
}

export const personalizeMessage = definePrompt<PersonalizeInput, z.infer<typeof PersonalizedMessageSchema>>({
  id: "personalize_message",
  version: 1,
  purpose: "Rewrite a rendered outreach template so it reads naturally, using only sourced facts.",
  system: [
    "Rewrite the draft outreach message so it is short, specific and natural in the given language.",
    "Use only the facts provided (each came from a cited source). Never add claims, numbers, names or links that are not in the draft or the facts.",
    "Keep any link and the call to action. Keep it under 90 words. No flattery, no emojis.",
    "confidence (0..1): how sure you are the message is accurate and appropriate to send; lower it if facts are thin.",
  ].join("\n"),
  render: (i) => `Language: ${i.language}\nOffer: ${json(i.offer)}\nFacts:\n${json(i.facts)}\n\nDraft subject: ${i.rendered.subject ?? "(none)"}\nDraft body:\n${i.rendered.body}`,
  output: PersonalizedMessageSchema,
  maxTokens: 2000,
  effort: "medium",
});

export const PROMPTS = { understandGoal, classifyReply, personalizeMessage } as const;
