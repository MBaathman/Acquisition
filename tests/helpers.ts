import { join } from "node:path";
import {
  AcquisitionEngine,
  AttributeResearchProvider,
  KeywordReplyClassifier,
  ManualClock,
  OutboxSender,
  StaticProspectSource,
  loadCampaignFile,
  type Actor,
  type CampaignConfig,
  type ChannelSender,
  type DiscoveredProspect,
  type InMemoryQueue,
} from "../src/index.js";

export const CAMPAIGNS = join(import.meta.dirname, "..", "campaigns");
export const DATASPEAKS = join(CAMPAIGNS, "dataspeaks/paid-subscribers.yaml");
export const TATIMMAH = join(CAMPAIGNS, "tatimmah/qualified-meetings.yaml");
export const REAL_ESTATE = join(CAMPAIGNS, "templates/real-estate-qualified-leads.yaml");

/** 10:00 in Riyadh — outside every configured quiet-hours window. */
export const START = new Date("2026-10-04T07:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export async function loadWith(path: string, patch: (c: CampaignConfig) => void = () => {}) {
  const cfg = await loadCampaignFile(path);
  patch(cfg);
  return cfg;
}

export function b2bProspect(i: number, overrides: Partial<DiscoveredProspect["contact"]> = {}): DiscoveredProspect {
  return {
    account: {
      name: `Company ${i}`,
      domain: `company${i}.sa`,
      industry: "retail",
      country: "SA",
      city: "Riyadh",
      employees: 300,
      attributes: { current_tool: "Excel", data_pain: "hiring analysts", recent_initiative: "expanding to Jeddah", sector: "retail" },
    },
    contact: {
      firstName: `Sara${i}`,
      lastName: "Test",
      title: "Head of Data",
      country: "SA",
      handles: { email: `sara${i}@company${i}.sa`, linkedin: `linkedin.com/in/sara${i}` },
      ...overrides,
    },
  };
}

export function setup(prospects: DiscoveredProspect[], opts: { channels?: Record<string, ChannelSender> } = {}) {
  const clock = new ManualClock(START);
  const outbox = new OutboxSender();
  const source = new StaticProspectSource(prospects);
  const engine = new AcquisitionEngine({
    clock,
    sources: { apollo: source, crm_import: source },
    research: { default: new AttributeResearchProvider() },
    channels: opts.channels ?? { email: outbox, linkedin: outbox, whatsapp: outbox },
    classifier: new KeywordReplyClassifier(),
  });
  const queue = engine.queue as InMemoryQueue;
  const run = async () => {
    await queue.runDue();
    if (queue.failures.length) throw queue.failures[0]!.error;
  };
  const advance = async (ms: number) => {
    clock.advance(ms);
    await run();
  };
  return { engine, clock, outbox, queue, run, advance };
}

export const approver = (clientId: string): Actor => ({ type: "user", id: `u-${clientId}`, clientId, roles: ["approver"] });

export async function pending(engine: AcquisitionEngine, campaignId: string, type?: string) {
  return engine.store.actions.find((a) => a.campaignId === campaignId && a.status === "pending_approval" && (!type || a.type === type));
}
