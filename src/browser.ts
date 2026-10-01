// Browser entry for the prototype UI: the same builder, schema validation and
// summary the engine uses, so the setup flow produces real campaign configs.
export { buildCampaignConfig, type CampaignDraft, type OutcomePreset, type BuilderPresets } from "./config/builder.js";
export { parseCampaignConfig, ConfigError } from "./config/validate.js";
export { summarizeCampaign } from "./config/summary.js";
