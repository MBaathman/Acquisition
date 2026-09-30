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
  qualify: { risk: "internal", description: "Evaluate qualification criteria" },
  send_message: { risk: "external", description: "Send a sequence touch on a channel" },
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

/** Journey milestones the engine recognises; campaigns map their own funnel stages onto them. */
export const MILESTONES = [
  "discovered",
  "researched",
  "contacted",
  "engaged",
  "qualified",
  "outcome",
  "lost",
] as const;
export type Milestone = (typeof MILESTONES)[number];
