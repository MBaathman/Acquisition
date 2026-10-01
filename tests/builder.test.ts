import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AcquisitionEngine,
  AttributeResearchProvider,
  FixtureContactFinder,
  KeywordReplyClassifier,
  ManualClock,
  OutboxSender,
  StaticProspectSource,
  buildCampaignConfig,
  summarizeCampaign,
  type BuilderPresets,
  type CampaignDraft,
  type InMemoryQueue,
} from "../src/index.js";
import { START, approver } from "./helpers.js";

const root = join(import.meta.dirname, "..", "presets");
const presets: BuilderPresets = {
  outcomes: JSON.parse(readFileSync(join(root, "outcomes.json"), "utf8")).presets,
  intents: JSON.parse(readFileSync(join(root, "replies.json"), "utf8")).intents,
};

/** The draft a first-time user produces in the setup flow (spec's final UX test). */
function uaeAgencyDraft(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    locale: "ar",
    client: { id: "c-dataspeaks", name: "DataSpeaks", industry: "SaaS", market: "AE" },
    campaign: { id: "k-uae-agencies", name: "استقطاب وكالات الإمارات", status: "active" },
    outcome: { preset: "paid_subscriber", goal: 50, value: { amount: 99, currency: "USD", recurrence: "monthly" } },
    audience: {
      countries: ["AE"], companyTypes: ["Performance marketing agency"], sizeMin: 5, sizeMax: 50, sectors: ["Marketing"],
      cities: [], titles: ["Founder", "Managing Director", "Head of Performance"], traits: [],
    },
    offer: {
      name: "DataSpeaks", valueProposition: "Automated client reporting across Meta, Google and TikTok.",
      callToAction: "Start a free trial", mainMessage: "Your client reports, built automatically from every ad account.",
      link: "https://dataspeaks.example/trial", language: "en",
    },
    qualification: {
      criteria: [
        { label: "Performance agency", points: 20 },
        { label: "3+ clients", points: 15 },
        { label: "Runs Meta ads", points: 10 },
        { label: "Runs Google ads", points: 10 },
        { label: "TikTok / Snapchat", points: 5 },
        { label: "Reporting requirement", points: 15 },
        { label: "5–50 employees", points: 10, check: { type: "size", min: 5, max: 50 } },
        { label: "Decision maker", points: 5, check: { type: "role", titles: ["Founder", "Managing Director", "CEO"] } },
        { label: "Growth signal", points: 5, timing: true },
      ],
      threshold: 70,
    },
    channels: { email: true, linkedin: true, touches: 2, waitDays: 3, language: "en", sendWindow: { startHour: 9, endHour: 18 } },
    automation: { level: "human_approval" },
    ...overrides,
  };
}

describe("campaign builder", () => {
  it("turns the setup answers into a valid campaign config", () => {
    const cfg = buildCampaignConfig(uaeAgencyDraft(), presets);
    expect(cfg.outcome).toMatchObject({ key: "paid_subscriber", label: "مشترك مدفوع", target: { count: 50 } });
    expect(cfg.client.timezone).toBe("Asia/Dubai");
    expect(cfg.scoring.scale).toBe("points");
    const summary = summarizeCampaign(cfg);
    expect(summary.scoring.max).toBe(95);
    expect(summary.scoring.minScore).toBe(70);
    expect(cfg.research.questions).toHaveLength(7); // the 7 researched criteria
    expect(cfg.outreach.sequence.map((s) => s.channel)).toEqual(["email", "auto"]);
    expect(cfg.constraints.maxTouchesPerProspect).toBe(2);
    expect(cfg.constraints.quietHours).toEqual({ startHour: 18, endHour: 9 });
    expect(cfg.autonomy.level).toBe("human_approval");
    expect(summary.autonomy.modes.send_message.mode).toBe("approval");
  });

  it.each(["paid_subscriber", "qualified_meeting", "qualified_lead", "opportunity", "custom"])("builds a valid config for the %s preset", (preset) => {
    const cfg = buildCampaignConfig(uaeAgencyDraft({ outcome: { preset, goal: 10, customLabel: "Demo request", customUnit: "request" } }), presets);
    expect(cfg.funnel.stages.some((s) => s.milestone === "outcome")).toBe(true);
    if (preset === "qualified_meeting") expect(cfg.appointments?.events.held).toBe("meeting.held");
    if (preset === "custom") expect(cfg.outcome.label).toBe("Demo request");
  });

  it("rejects a draft with no channel", () => {
    expect(() => buildCampaignConfig(uaeAgencyDraft({ channels: { email: false, linkedin: false, touches: 1, waitDays: 3, language: "en", sendWindow: { startHour: 9, endHour: 18 } } }), presets)).toThrow(/channel/);
  });

  it("runs on the engine: sourced criteria score, the first message waits for approval", async () => {
    const cfg = buildCampaignConfig(uaeAgencyDraft(), presets);
    const sourced = { source: "Agency website", url: "https://falcon.demo/services", confidence: 0.9 };
    const facts = Object.fromEntries(cfg.research.questions.map((q) => [q.key, true]));
    const source = new StaticProspectSource([
      {
        account: { name: "Falcon Media Lab", domain: "falcon.demo", country: "AE", city: "Dubai", employees: 20, attributes: { ...facts, _sources: Object.fromEntries(Object.keys(facts).map((k) => [k, sourced])) } },
        contact: { firstName: "Layla", title: "Founder", handles: { email: "layla@falcon.demo", linkedin: "linkedin.com/in/layla" } },
      },
    ]);
    const outbox = new OutboxSender();
    const engine = new AcquisitionEngine({
      clock: new ManualClock(START), sources: { default: source }, research: { default: new AttributeResearchProvider() },
      contactFinders: { default: new FixtureContactFinder() }, channels: { email: outbox, linkedin: outbox }, classifier: new KeywordReplyClassifier(),
    });
    await engine.registerCampaign(cfg);
    await (engine.queue as InMemoryQueue).runDue();

    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.score).toBe(95);
    expect(p!.researchStatus).toBe("complete");
    const pending = await engine.store.actions.find((a) => a.status === "pending_approval");
    expect(pending).toHaveLength(1);
    expect(String(pending[0]!.payload.body)).toContain("Hi Layla");
    expect(outbox.sent).toHaveLength(0);
    await engine.approve(pending[0]!.id, approver("c-dataspeaks"));
    await (engine.queue as InMemoryQueue).runDue();
    expect(outbox.sent).toHaveLength(1);
  });
});
