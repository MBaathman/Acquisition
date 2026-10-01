/**
 * Runs every active campaign in ./campaigns on the same engine with sample
 * prospects, auto-approving pending actions as a stand-in for a reviewer,
 * then prints each client's report.
 */
import {
  AcquisitionEngine,
  AttributeResearchProvider,
  KeywordReplyClassifier,
  ManualClock,
  OutboxSender,
  StaticProspectSource,
  loadCampaignDir,
  type InMemoryQueue,
  type Rule,
} from "../index.js";

/** Find the event type a campaign's outcome rule listens for, so the demo can simulate it. */
function outcomeEventType(rule: Rule): string {
  if ("all" in rule || "any" in rule) {
    for (const r of "all" in rule ? rule.all : rule.any) {
      const t = outcomeEventType(r);
      if (t) return t;
    }
  }
  if ("field" in rule && rule.field === "event.type") return String(Array.isArray(rule.value) ? rule.value[0] : rule.value);
  return "";
}

// Fictional sample prospects: half fit a UAE-agency ICP, half a KSA-enterprise ICP.
// Every research fact cites a (fictional) source; the engine discards unsourced ones.
const sourced = (domain: string) => ({
  agency_type: { source: "Company website — services", url: `https://${domain}/services` },
  client_count: { source: "Company website — case studies", url: `https://${domain}/work` },
  ad_platforms: { source: "Ad platform partner directories" },
  reporting_requirement: { source: "Job post — Reporting Analyst" },
  sector: { source: "Company registry" },
  recent_initiative: { source: "Press release", url: `https://${domain}/news` },
});
const sample = Array.from({ length: 12 }, (_, i) => {
  const uae = i % 2 === 0;
  const domain = `sample${i + 1}.demo`;
  return {
    account: {
      name: `Sample Co ${i + 1}`, domain, country: uae ? "AE" : "SA", city: uae ? "Dubai" : "Riyadh", employees: uae ? 20 + i : 150 + i * 40,
      attributes: {
        agency_type: "performance", client_count: 6 + i, ad_platforms: ["meta", "google"], reporting_requirement: "monthly client reports",
        sector: "retail", recent_initiative: "expanding operations", _sources: sourced(domain),
      },
    },
    contact: {
      firstName: `Contact${i + 1}`, title: i % 3 === 0 ? "CEO" : uae ? "Founder" : "Head of Operations",
      handles: { email: `contact${i + 1}@${domain}`, linkedin: `linkedin.com/in/c${i + 1}` },
    },
  };
});

const clock = new ManualClock(new Date("2026-10-04T07:00:00Z"));
const outbox = new OutboxSender();
const source = new StaticProspectSource(sample);
const engine = new AcquisitionEngine({
  clock,
  sources: new Proxy({}, { get: () => source }),
  research: { default: new AttributeResearchProvider() },
  channels: new Proxy({}, { get: () => outbox }),
  classifier: new KeywordReplyClassifier(),
});
const queue = engine.queue as InMemoryQueue;
const reviewer = (clientId: string) => ({ type: "user" as const, id: "demo-reviewer", clientId, roles: ["approver"] });

const campaigns = (await loadCampaignDir("campaigns")).filter((c) => c.campaign.status === "active");
for (const cfg of campaigns) await engine.registerCampaign(cfg);

for (let hour = 0; hour < 24 * 14; hour++) {
  await queue.runDue();
  for (const a of await engine.store.actions.find((a) => a.status === "pending_approval")) {
    await engine.approve(a.id, reviewer(a.clientId));
  }
  await queue.runDue();
  if (hour === 30) {
    for (const cfg of campaigns) {
      const [p] = await engine.store.prospects.find((p) => p.campaignId === cfg.campaign.id && p.status === "active");
      if (p) await engine.receiveReply({ campaignId: cfg.campaign.id, prospectId: p.id, channel: "email", text: "Interested — can we schedule a call? Happy to start a trial." });
    }
  }
  if (hour === 60) {
    for (const cfg of campaigns) {
      const [p] = await engine.store.prospects.find((p) => p.campaignId === cfg.campaign.id && Boolean(p.lastIntent));
      const type = outcomeEventType(cfg.outcome.achievedWhen);
      if (p) await engine.recordEvent({ campaignId: cfg.campaign.id, prospectId: p.id, type, payload: { amount: 99 } });
    }
  }
  clock.advance(3_600_000);
}

for (const cfg of campaigns) {
  const r = await engine.report(cfg.campaign.id);
  console.log(`\n=== ${r.client.name} — ${r.campaign.name} [autonomy: ${r.campaign.autonomy}] ===`);
  console.log(`${r.outcome.label}s: ${r.outcome.achieved}/${r.outcome.target ?? "-"} (${r.outcome.progressPct ?? 0}%)` +
    (r.outcome.value ? `  value: ${r.outcome.value.amount} ${r.outcome.value.currency}` : ""));
  console.log("Pipeline:", r.pipeline.map((s) => `${s.label}=${s.count}`).join("  "));
  console.log("Activity:", r.activity);
  console.log("Attribution:", r.attribution.byChannel, r.attribution.byStep);
  console.log(`Needs attention: ${r.attention.pendingApprovals} approvals, ${r.attention.exceptions.length} exceptions`);
  r.attention.exceptions.forEach((e) => console.log(`  - [${e.severity}] ${e.reason}`));
}
console.log(`\nMessages sent across all clients: ${outbox.sent.length}`);
