import { loadCampaignDir } from "../config/loader.js";

const dir = process.argv[2] ?? "campaigns";
try {
  const configs = await loadCampaignDir(dir);
  for (const c of configs) {
    console.log(`✓ ${c.client.id}/${c.campaign.id}  outcome=${c.outcome.key}  autonomy=${c.autonomy.level}  status=${c.campaign.status}`);
  }
  console.log(`${configs.length} campaign config(s) valid.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
