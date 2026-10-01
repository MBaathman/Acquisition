/**
 * Catalog of action types the engine's agents can take. Every autonomous step
 * is expressed as one of these and goes through the governance gateway.
 *
 * `risk` decides the default autonomy treatment:
 *   - internal:  affects only engine state (research, scoring...)
 *   - external:  visible to a prospect or third party (sending, replying...)
 *   - strategic: changes how the campaign behaves (optimization changes)
 */
export const ACTION_TYPES = {
  discover: { risk: "internal", description: "Find new prospects from a source" },
  research: { risk: "internal", description: "Research an account/contact" },
  score: { risk: "internal", description: "Score and check ICP fit" },
  enrich_contact: { risk: "internal", description: "Find a reachable contact handle for a fit prospect" },
  qualify: { risk: "internal", description: "Evaluate qualification criteria" },
  send_message: { risk: "external", description: "Send the first outreach touch" },
  follow_up: { risk: "external", description: "Send a follow-up touch in the sequence" },
  respond: { risk: "external", description: "Reply to an inbound prospect message" },
  conversion_step: { risk: "external", description: "Push a qualified prospect to the outcome (booking link, checkout, handoff)" },
  optimize: { risk: "strategic", description: "Apply a learned optimization to the campaign" },
} as const;

export type ActionType = keyof typeof ACTION_TYPES;
export type ActionRisk = (typeof ACTION_TYPES)[ActionType]["risk"];
export const ACTION_TYPE_KEYS = Object.keys(ACTION_TYPES) as [ActionType, ...ActionType[]];

export const AUTONOMY_LEVELS = ["human_approval", "assisted", "autonomous"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const ACTION_MODES = ["autonomous", "approval", "disabled"] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

/**
 * Default mode per (level, risk). Moving a campaign between levels is a config
 * change; per-action overrides in `autonomy.actions` take precedence.
 */
export const DEFAULT_MODES: Record<AutonomyLevel, Record<ActionRisk, ActionMode>> = {
  human_approval: { internal: "autonomous", external: "approval", strategic: "approval" },
  // assisted: external actions run on their own when confidence clears the threshold
  assisted: { internal: "autonomous", external: "autonomous", strategic: "approval" },
  autonomous: { internal: "autonomous", external: "autonomous", strategic: "autonomous" },
};

/** Default confidence thresholds per level for autonomous execution. */
export const DEFAULT_MIN_CONFIDENCE: Record<AutonomyLevel, number> = {
  human_approval: 0,
  assisted: 0.85,
  autonomous: 0.7,
};

/**
 * Journey milestones the engine recognises; campaigns map their own funnel
 * stages onto them (and may add event-driven stages in between).
 *   fit      — scored at or above the campaign's outreach threshold
 *   replied  — any reply
 *   engaged  — a positive reply
 */
export const MILESTONES = [
  "discovered",
  "researched",
  "fit",
  "contacted",
  "replied",
  "engaged",
  "qualified",
  "outcome",
  "lost",
] as const;

/** Outbound action types that count as sequence touches (spacing, caps, rate limits). */
export const TOUCH_ACTIONS: readonly ActionType[] = ["send_message", "follow_up"];
export type Milestone = (typeof MILESTONES)[number];
