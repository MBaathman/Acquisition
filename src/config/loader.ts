import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { CampaignConfig } from "./schema.js";
import { parseCampaignConfig } from "./validate.js";

export { ConfigError, parseCampaignConfig } from "./validate.js";

export async function loadCampaignFile(path: string): Promise<CampaignConfig> {
  return parseCampaignConfig(parse(await readFile(path, "utf8")), path);
}

export async function loadCampaignDir(dir: string): Promise<CampaignConfig[]> {
  const files = (await readdir(dir, { recursive: true }))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  return Promise.all(files.map((f) => loadCampaignFile(join(dir, f))));
}
