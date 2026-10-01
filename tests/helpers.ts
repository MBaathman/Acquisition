import { join } from "node:path";
import {
  AcquisitionEngine,
  AttributeResearchProvider,
  FixtureContactFinder,
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
export const DATASPEAKS = join(CAMPAIGNS, "dataspeaks/uae-agency-acquisition.yaml");
export const TATIMMAH = join(CAMPAIGNS, "tatimmah/saudi-enterprise-outreach.yaml");
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

const src = (source: string, url?: string) => ({ source, url, confidence: 0.9 });

/**
 * A fixture prospect whose research facts all cite a source. `market` picks
 * firmographics that fit the DataSpeaks (UAE agency) or Tatimmah (KSA
 * enterprise) campaign.
 */
export function b2bProspect(
  i: number,
  overrides: Partial<DiscoveredProspect["contact"]> = {},
  market: "ae_agency" | "sa_enterprise" = "ae_agency",
): DiscoveredProspect {
  const agency = market === "ae_agency";
  return {
    account: {
      name: `Company ${i}`,
      domain: `company${i}.example`,
      industry: agency ? "marketing" : "retail",
      country: agency ? "AE" : "SA",
      city: agency ? "Dubai" : "Riyadh",
      employees: agency ? 30 : 300,
      attributes: {
        agency_type: "performance",
        client_count: 12,
        ad_platforms: ["meta", "google", "tiktok"],
        reporting_requirement: "monthly client reports",
        growth_signal: "hiring two media buyers",
        sector: "retail",
        recent_initiative: "expanding to Jeddah",
        _sources: {
          agency_type: src("Company website — services page", `https://company${i}.example/services`),
          client_count: src("Company website — case studies", `https://company${i}.example/work`),
          ad_platforms: src("Meta & Google partner directories"),
          reporting_requirement: src("Job post — Reporting Analyst"),
          growth_signal: src("LinkedIn jobs page"),
          sector: src("Company registry"),
          recent_initiative: src("Press release", `https://company${i}.example/news`),
        },
      },
    },
    contact: {
      firstName: `Sara${i}`,
      lastName: "Test",
      title: agency ? "Founder" : "Head of Data",
      country: agency ? "AE" : "SA",
      handles: { email: `sara${i}@company${i}.example`, linkedin: `linkedin.com/in/sara${i}` },
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
    contactFinders: { demo_finder: new FixtureContactFinder() },
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
export const admin = (clientId: string): Actor => ({ type: "user", id: `a-${clientId}`, clientId, roles: ["admin"] });

export async function pending(engine: AcquisitionEngine, campaignId: string, type?: string) {
  return engine.store.actions.find((a) => a.campaignId === campaignId && a.status === "pending_approval" && (!type || a.type === type));
}
