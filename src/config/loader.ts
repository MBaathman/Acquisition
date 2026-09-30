import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
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

export async function loadCampaignFile(path: string): Promise<CampaignConfig> {
  return parseCampaignConfig(parse(await readFile(path, "utf8")), path);
}

export async function loadCampaignDir(dir: string): Promise<CampaignConfig[]> {
  const files = (await readdir(dir, { recursive: true }))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  return Promise.all(files.map((f) => loadCampaignFile(join(dir, f))));
}
