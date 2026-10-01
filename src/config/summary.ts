import { ACTION_TYPES, type ActionType } from "./actions.js";
import type { Rule } from "./rules.js";
import type { CampaignConfig } from "./schema.js";
import { resolveMode } from "./autonomy.js";

const fieldsOf = (rule: Rule): string[] =>
  "field" in rule ? [rule.field] : "all" in rule ? rule.all.flatMap(fieldsOf) : "any" in rule ? rule.any.flatMap(fieldsOf) : "not" in rule ? fieldsOf(rule.not) : [];

/**
 * A presentation-ready summary of a campaign config: what a UI needs to show
 * the campaign (outcome, funnel, scoring model, channels, automation modes,
 * guardrails) without re-implementing config semantics.
 */
export function summarizeCampaign(cfg: CampaignConfig) {
  const modes = Object.fromEntries(
    (Object.keys(ACTION_TYPES) as ActionType[]).map((t) => [t, { ...resolveMode(cfg, t), risk: ACTION_TYPES[t].risk, allowed: cfg.autonomy.allowedActions.includes(t) }]),
  );
  return {
    id: cfg.campaign.id, name: cfg.campaign.name, status: cfg.campaign.status, description: cfg.campaign.description, period: cfg.campaign.period, budget: cfg.campaign.budget,
    outcome: { key: cfg.outcome.key, label: cfg.outcome.label, unit: cfg.outcome.unit, target: cfg.outcome.target?.count, currency: cfg.outcome.value?.currency, requiresQualification: cfg.outcome.requiresQualification },
    icp: cfg.icp.description, personas: cfg.icp.personas.map((p) => ({ key: p.key, label: p.label })), market: cfg.market, offer: cfg.offer,
    scoring: {
      scale: cfg.scoring.scale,
      signals: cfg.scoring.signals.map((s) => ({ key: s.key, label: s.label, weight: s.weight, category: s.category, reads: fieldsOf(s.when) })),
      tiers: cfg.scoring.tiers, minScore: cfg.outreach.minScore,
      max: cfg.scoring.scale === "points" ? cfg.scoring.signals.reduce((a, s) => a + Math.max(0, s.weight), 0) : 100,
    },
    research: cfg.research.questions.map((q) => ({ key: q.key, prompt: q.prompt, required: q.required })), researchMinConfidence: cfg.research.minConfidence,
    qualification: cfg.qualification.criteria.map((c) => ({ key: c.key, label: c.label, required: c.required })),
    funnel: cfg.funnel.stages.map((s) => ({ key: s.key, label: s.label, milestone: s.milestone, onEvent: Boolean(s.onEvent) })),
    appointments: cfg.appointments ? { label: cfg.appointments.label, singular: cfg.appointments.singular } : null,
    channels: cfg.outreach.channels,
    sequence: cfg.outreach.sequence.map((s) => ({ key: s.key, channel: s.channel, dayOffset: s.dayOffset, template: s.template })),
    intents: cfg.replies.intents.map((i) => ({ key: i.key, label: i.label, sentiment: i.sentiment })), minClassificationConfidence: cfg.replies.minClassificationConfidence,
    autonomy: { level: cfg.autonomy.level, modes },
    constraints: { quietHours: cfg.constraints.quietHours, maxTouches: cfg.constraints.maxTouchesPerProspect, minHoursBetweenTouches: cfg.constraints.minHoursBetweenTouches, rateLimits: cfg.constraints.rateLimits, retry: cfg.constraints.retry },
    escalation: cfg.escalation.rules.map((r) => ({ key: r.key, reason: r.reason, severity: r.severity })),
    integrations: { discovery: cfg.discovery.source, research: cfg.research.provider, contactFinder: cfg.contacts.finder, channels: cfg.outreach.channels.map((c) => c.key) },
    dimensions: cfg.analytics.dimensions,
    timezone: cfg.client.timezone,
  };
}
export type CampaignSummary = ReturnType<typeof summarizeCampaign>;
