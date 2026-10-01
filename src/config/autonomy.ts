import { ACTION_TYPES, DEFAULT_MIN_CONFIDENCE, DEFAULT_MODES, type ActionMode, type ActionType } from "./actions.js";
import type { CampaignConfig } from "./schema.js";

/** Effective mode and confidence threshold for an action type under a campaign's autonomy settings. */
export function resolveMode(cfg: CampaignConfig, type: ActionType): { mode: ActionMode; minConfidence: number } {
  const level = cfg.autonomy.level;
  const override = cfg.autonomy.actions[type] ?? {};
  return {
    mode: override.mode ?? DEFAULT_MODES[level][ACTION_TYPES[type].risk],
    minConfidence: override.minConfidence ?? DEFAULT_MIN_CONFIDENCE[level],
  };
}
