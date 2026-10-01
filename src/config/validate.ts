import { CampaignConfigSchema, type CampaignConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(source: string, public readonly issues: string[]) {
    super(`Invalid campaign config (${source}):\n  - ${issues.join("\n  - ")}`);
  }
}

export function parseCampaignConfig(raw: unknown, source = "<inline>"): CampaignConfig {
  const result = CampaignConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(source, result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return result.data;
}
