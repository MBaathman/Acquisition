import { z } from "zod";
import { RuleSchema } from "./rules.js";
import { ACTION_MODES, ACTION_TYPE_KEYS, AUTONOMY_LEVELS, MILESTONES } from "./actions.js";

/**
 * Campaign configuration schema.
 *
 * Everything that differs between clients, industries and outcomes lives here.
 * The engine never references a specific client, industry or outcome — a new
 * campaign is onboarded by writing a config file, not new application code.
 */

const Key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "keys must be lowercase slug-like identifiers");

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export const ClientSchema = z.object({
  id: Key,
  name: z.string().min(1),
  industry: z.string().optional(),
  website: z.string().optional(),
  timezone: z.string().default("UTC"),
});

// ---------------------------------------------------------------------------
// Custom fields — extra attributes a campaign cares about (seats, budget,
// property_type...). Stored under `attributes` on entities.
// ---------------------------------------------------------------------------
export const FieldSchema = z.object({
  key: Key,
  label: z.string(),
  entity: z.enum(["account", "contact", "prospect"]),
  type: z.enum(["string", "number", "boolean", "enum", "multi_enum", "date", "money", "geo"]),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Outcome — the generic "what counts as a win" definition.
// ---------------------------------------------------------------------------
export const OutcomeSchema = z.object({
  /** e.g. paid_subscriber | qualified_meeting | qualified_lead | any custom key */
  key: Key,
  label: z.string(),
  description: z.string().optional(),
  /** Unit noun used in client reporting (e.g. the singular of what is counted). */
  unit: z.string().default("outcome"),
  /** Matched against recorded events (`event.*`) plus prospect context. */
  achievedWhen: RuleSchema,
  /** If true, outcomes from unqualified prospects are flagged and not counted. */
  requiresQualification: z.boolean().default(false),
  value: z
    .object({
      amount: z.number().nonnegative(),
      currency: z.string().default("USD"),
      recurrence: z.enum(["one_time", "monthly", "annual"]).default("one_time"),
      /** Optional dot-path into the event context overriding the static amount. */
      fromField: z.string().optional(),
    })
    .optional(),
  target: z
    .object({
      count: z.number().int().positive(),
      periodStart: z.string().optional(),
      periodEnd: z.string().optional(),
    })
    .optional(),
  /** What the engine does once a prospect qualifies (send booking link, checkout link, ...). */
  conversionStep: z.object({ template: Key, channel: z.string().optional() }).optional(),
});

// ---------------------------------------------------------------------------
// ICP, Market, Offer
// ---------------------------------------------------------------------------
export const IcpSchema = z.object({
  description: z.string().optional(),
  /** B2B targets accounts + contacts; consumer-style campaigns may target individuals. */
  targetType: z.enum(["account", "individual"]).default("account"),
  personas: z.array(z.object({ key: Key, label: z.string(), match: RuleSchema })).default([]),
  fit: RuleSchema.default({ always: true }),
  exclusions: RuleSchema.optional(),
});

export const MarketSchema = z.object({
  geographies: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  segments: z.array(z.string()).default([]),
});

export const OfferSchema = z.object({
  name: z.string(),
  valueProposition: z.string(),
  proofPoints: z.array(z.string()).default([]),
  callToAction: z.string(),
  pricing: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Discovery & Research
// ---------------------------------------------------------------------------
export const DiscoverySchema = z.object({
  /** Registered ProspectSource adapter key (e.g. "apollo", "clay", "listings"). */
  source: z.string(),
  /** Free-form query passed to the source adapter. */
  query: z.record(z.unknown()).default({}),
  /** Keep this many prospects in active play; discovery tops the pool up. */
  targetActivePool: z.number().int().positive().default(100),
  batchSize: z.number().int().positive().default(25),
  /** Skip people already enrolled in another campaign of the same client. */
  dedupeAcrossCampaigns: z.boolean().default(true),
});

export const ResearchSchema = z.object({
  provider: z.string().default("default"),
  questions: z
    .array(z.object({ key: Key, prompt: z.string(), mapsTo: z.string().optional() }))
    .default([]),
});

// ---------------------------------------------------------------------------
// Scoring & Qualification
// ---------------------------------------------------------------------------
export const ScoringSchema = z.object({
  signals: z
    .array(z.object({ key: Key, label: z.string(), weight: z.number(), when: RuleSchema }))
    .default([]),
  tiers: z
    .array(z.object({ key: Key, label: z.string(), min: z.number() }))
    .default([
      { key: "a", label: "Tier A", min: 70 },
      { key: "b", label: "Tier B", min: 40 },
      { key: "c", label: "Tier C", min: 0 },
    ]),
});

export const QualificationSchema = z.object({
  framework: z.string().default("custom"),
  criteria: z
    .array(
      z.object({
        key: Key,
        label: z.string(),
        required: z.boolean().default(false),
        when: RuleSchema,
      }),
    )
    .default([]),
  minCriteriaMet: z.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// Funnel — client-facing stages mapped onto engine milestones.
// ---------------------------------------------------------------------------
export const FunnelSchema = z.object({
  stages: z
    .array(
      z.object({
        key: Key,
        label: z.string(),
        milestone: z.enum(MILESTONES).optional(),
      }),
    )
    .min(2),
});

// ---------------------------------------------------------------------------
// Personalization — templates may carry variants for experimentation.
// ---------------------------------------------------------------------------
const VariantSchema = z.object({ key: Key, subject: z.string().optional(), body: z.string() });

const TemplateSchema = z
  .object({
    subject: z.string().optional(),
    body: z.string().optional(),
    variants: z.array(VariantSchema).optional(),
  })
  .refine((t) => Boolean(t.body) !== Boolean(t.variants?.length), {
    message: "template needs either `body` or `variants`, not both",
  })
  .transform((t) => ({
    variants: t.variants ?? [{ key: "default", subject: t.subject, body: t.body! }],
  }));

export const PersonalizationSchema = z.object({
  tone: z.string().default("professional"),
  language: z.string().default("en"),
  snippets: z.array(z.object({ key: Key, when: RuleSchema, text: z.string() })).default([]),
  templates: z.record(Key, TemplateSchema),
});

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------
export const OutreachSchema = z.object({
  channels: z
    .array(
      z.object({
        key: Key,
        /** Which contact handle this channel needs (email, linkedin, phone...). */
        handle: z.string(),
        consentRequired: z.boolean().default(false),
      }),
    )
    .min(1),
  sequence: z
    .array(
      z.object({
        key: Key,
        /** A channel key, or "auto" to let the engine pick the best reachable channel. */
        channel: z.string(),
        dayOffset: z.number().int().nonnegative(),
        template: Key,
        when: RuleSchema.optional(),
      }),
    )
    .min(1),
  /** Prospects scoring below this are parked instead of contacted. */
  minScore: z.number().default(0),
});

// ---------------------------------------------------------------------------
// Replies & conversations
// ---------------------------------------------------------------------------
export const RepliesSchema = z.object({
  intents: z
    .array(
      z.object({
        key: Key,
        label: z.string(),
        sentiment: z.enum(["positive", "neutral", "negative"]).default("neutral"),
        keywords: z.array(z.string()).default([]),
        milestone: z.enum(MILESTONES).optional(),
        stopSequence: z.boolean().default(false),
        /** Template for an automatic routine reply. */
        respondWith: Key.optional(),
        /** Suppress the contact permanently (opt-out). */
        suppress: z.boolean().default(false),
      }),
    )
    .min(1),
  defaultIntent: Key,
  /** Below this classifier confidence, the reply is escalated to a human. */
  minClassificationConfidence: z.number().min(0).max(1).default(0.6),
});

// ---------------------------------------------------------------------------
// Governance: autonomy, constraints, escalation
// ---------------------------------------------------------------------------
export const AutonomySchema = z.object({
  level: z.enum(AUTONOMY_LEVELS).default("human_approval"),
  /** Per-action overrides of the level defaults. */
  actions: z
    .record(
      z.enum(ACTION_TYPE_KEYS),
      z.object({
        mode: z.enum(ACTION_MODES).optional(),
        minConfidence: z.number().min(0).max(1).optional(),
      }),
    )
    .default({}),
  /** Action types the engine's agent actor is permitted to perform at all. */
  allowedActions: z.array(z.enum(ACTION_TYPE_KEYS)).default([...ACTION_TYPE_KEYS]),
});

export const ConstraintsSchema = z.object({
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .optional(),
  maxTouchesPerProspect: z.number().int().positive().default(6),
  minHoursBetweenTouches: z.number().nonnegative().default(48),
  suppressedDomains: z.array(z.string()).default([]),
  suppressedHandles: z.array(z.string()).default([]),
  rateLimits: z
    .array(
      z.object({
        action: z.enum(ACTION_TYPE_KEYS),
        channel: z.string().optional(),
        perHour: z.number().int().positive().optional(),
        perDay: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  retry: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      backoffSeconds: z.number().positive().default(60),
      multiplier: z.number().min(1).default(2),
    })
    .default({}),
});

export const EscalationSchema = z.object({
  rules: z
    .array(
      z.object({
        key: Key,
        when: RuleSchema,
        severity: z.enum(["low", "medium", "high"]).default("medium"),
        reason: z.string(),
        /** Pause the prospect's automation until a human resolves it. */
        pauseProspect: z.boolean().default(true),
      }),
    )
    .default([]),
});

export const OptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  /** Minimum sends per arm before the optimizer draws conclusions. */
  minSampleSize: z.number().int().positive().default(30),
  cadenceHours: z.number().positive().default(24),
});

export const SchedulingSchema = z.object({
  /** How often the background loop re-evaluates the campaign. */
  tickMinutes: z.number().positive().default(15),
});

// ---------------------------------------------------------------------------
// Campaign (root)
// ---------------------------------------------------------------------------
export const CampaignConfigSchema = z
  .object({
    version: z.literal(1),
    client: ClientSchema,
    campaign: z.object({
      id: Key,
      name: z.string(),
      status: z.enum(["draft", "active", "paused", "completed"]).default("draft"),
    }),
    outcome: OutcomeSchema,
    fields: z.array(FieldSchema).default([]),
    icp: IcpSchema,
    market: MarketSchema.default({}),
    offer: OfferSchema,
    discovery: DiscoverySchema,
    research: ResearchSchema.default({}),
    scoring: ScoringSchema.default({}),
    qualification: QualificationSchema.default({}),
    funnel: FunnelSchema,
    personalization: PersonalizationSchema,
    outreach: OutreachSchema,
    replies: RepliesSchema,
    autonomy: AutonomySchema.default({}),
    constraints: ConstraintsSchema.default({}),
    escalation: EscalationSchema.default({}),
    optimization: OptimizationSchema.default({}),
    scheduling: SchedulingSchema.default({}),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const stageKeys = cfg.funnel.stages.map((s) => s.key);
    const templateKeys = new Set(Object.keys(cfg.personalization.templates));
    const intentKeys = new Set(cfg.replies.intents.map((i) => i.key));
    const channelKeys = new Set(cfg.outreach.channels.map((c) => c.key));

    const dupes = stageKeys.filter((k, i, a) => a.indexOf(k) !== i);
    if (dupes.length) issue(["funnel", "stages"], `duplicate stage keys: ${dupes.join(", ")}`);
    for (const m of ["discovered", "outcome"] as const) {
      if (cfg.funnel.stages.filter((s) => s.milestone === m).length !== 1) {
        issue(["funnel", "stages"], `exactly one stage must have milestone '${m}'`);
      }
    }
    cfg.outreach.sequence.forEach((step, i) => {
      if (!templateKeys.has(step.template)) issue(["outreach", "sequence", i, "template"], `unknown template '${step.template}'`);
      if (step.channel !== "auto" && !channelKeys.has(step.channel)) {
        issue(["outreach", "sequence", i, "channel"], `unknown channel '${step.channel}'`);
      }
    });
    cfg.replies.intents.forEach((intent, i) => {
      if (intent.respondWith && !templateKeys.has(intent.respondWith)) {
        issue(["replies", "intents", i, "respondWith"], `unknown template '${intent.respondWith}'`);
      }
    });
    if (!intentKeys.has(cfg.replies.defaultIntent)) issue(["replies", "defaultIntent"], `unknown intent '${cfg.replies.defaultIntent}'`);
    const cs = cfg.outcome.conversionStep;
    if (cs && !templateKeys.has(cs.template)) issue(["outcome", "conversionStep", "template"], `unknown template '${cs.template}'`);
    if (cs?.channel && !channelKeys.has(cs.channel)) issue(["outcome", "conversionStep", "channel"], `unknown channel '${cs.channel}'`);
  });

export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;
export type CampaignConfigInput = z.input<typeof CampaignConfigSchema>;
export type OutcomeDefinition = CampaignConfig["outcome"];
export type Template = CampaignConfig["personalization"]["templates"][string];
