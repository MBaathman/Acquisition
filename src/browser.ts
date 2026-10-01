// Browser entry for the prototype UI: the same builder, schema validation,
// planner, intelligence layer and engine the server uses. No model SDK and no
// API key: model calls go through the intelligence service to a provider the
// host supplies (or not at all — the rules answer).
export { buildCampaignConfig, type CampaignDraft, type OutcomePreset, type BuilderPresets } from "./config/builder.js";
export { parseCampaignConfig, ConfigError } from "./config/validate.js";
export { summarizeCampaign } from "./config/summary.js";
export { planFromRequest, buildPlan, applyAnswer, planSteps, extractGoal, normalize } from "./agent/planner.js";
export { understandRequest, rulesAreConfident } from "./agent/plans.js";
export { simulateFirstRun } from "./agent/simulation.js";
export { IntelligenceService } from "./intelligence/service.js";
export { PromptJsonProvider } from "./intelligence/edge-provider.js";
export { AcquisitionAgent, countsOf } from "./agent/agent.js";
export { DECISION_POLICY, countOf, diffPlans, applyChanges } from "./agent/planner.js";
