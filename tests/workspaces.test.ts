import { describe, expect, it } from "vitest";
import { DATASPEAKS, DAY, TATIMMAH, admin, approver, b2bProspect, loadWith, pending, setup } from "./helpers.js";

describe("research never uses unsourced claims", () => {
  it("discards answers without a source and flags the prospect for review", async () => {
    const fixture = b2bProspect(1);
    const sources = fixture.account!.attributes!._sources as Record<string, unknown>;
    delete sources.agency_type; // the "performance agency" claim now has no source
    const { engine, run } = setup([fixture]);
    const cfg = await loadWith(DATASPEAKS);
    await engine.registerCampaign(cfg);
    await run();

    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.researchStatus).toBe("needs_review");
    expect(p!.research!.rejected).toEqual(["agency_type"]);
    expect(p!.research!.missing).toEqual(["agency_type"]);
    expect(p!.research!.signals.every((s) => s.source)).toBe(true);
    // The unsourced claim earns no points.
    expect(p!.scoreBreakdown!.map((b) => b.key)).not.toContain("performance_agency");
    const trail = await engine.audit.trail({ clientId: "dataspeaks", prospectId: p!.id });
    expect(trail.find((e) => e.event === "research.completed")?.detail).toMatchObject({ rejectedUnsourced: ["agency_type"] });
  });
});

describe("campaign-specific scoring", () => {
  it("scores the DataSpeaks agency model in points out of 95", async () => {
    const { engine, run } = setup([b2bProspect(1)]);
    await engine.registerCampaign(await loadWith(DATASPEAKS));
    await run();
    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.scoreMax).toBe(95);
    expect(p!.score).toBe(95);
    expect(p!.tier).toBe("a");
    expect(p!.scoreBreakdown!.filter((b) => b.category === "timing").map((b) => b.label)).toEqual(["Growth signal"]);
    expect(p!.milestones.fit).toBeDefined();
    expect(p!.stage).toBe("high_fit");
  });
});

describe("contacts", () => {
  it("finds a handle for a fit prospect with no reachable contact, then reaches out", async () => {
    const { engine, run } = setup([
      b2bProspect(1, { handles: {}, attributes: { _findable: { handles: { email: "found@company1.example" }, source: "Company website — team page" } } }),
      b2bProspect(2, { handles: {} }),
    ]);
    const cfg = await loadWith(DATASPEAKS);
    await engine.registerCampaign(cfg);
    await run();
    const prospects = await engine.store.prospects.find(() => true);
    const found = prospects.find((p) => p.contactStatus === "found")!;
    const missing = prospects.find((p) => p.contactStatus === "not_found")!;
    expect(found).toBeDefined();
    expect(missing.status).toBe("parked");
    expect((await pending(engine, cfg.campaign.id, "send_message")).map((a) => a.payload.to)).toEqual(["found@company1.example"]);
  });
});

describe("follow-ups are their own governed action", () => {
  it("lets follow-ups run autonomously while first touches still need approval", async () => {
    const { engine, outbox, run, advance } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.actions = { follow_up: { mode: "autonomous" } }));
    await engine.registerCampaign(cfg);
    await run();
    const [first] = await pending(engine, cfg.campaign.id, "send_message");
    await engine.approve(first!.id, approver("dataspeaks"));
    await run();
    expect(outbox.sent).toHaveLength(1);

    const [p] = await engine.store.prospects.find(() => true);
    const draft = await engine.previewNextTouch(p!.id);
    expect(draft).toMatchObject({ stepKey: "s2_follow_up" });
    expect(String(draft!.body)).toContain("following up");

    await advance(3 * DAY);
    expect(outbox.sent).toHaveLength(2);
    const followUp = (await engine.store.actions.find((a) => a.type === "follow_up"))[0]!;
    expect(followUp.decidedBy?.type).toBe("system");
    await advance(10 * DAY);
    expect(outbox.sent).toHaveLength(2); // max 2 touches
  });

  it("only admins change automation, and every change is audited", async () => {
    const { engine } = setup([]);
    const cfg = await loadWith(DATASPEAKS);
    await engine.registerCampaign(cfg);
    await expect(engine.setAutonomy(cfg.campaign.id, { level: "autonomous" }, approver("dataspeaks"))).rejects.toThrow(/admin/);
    await expect(engine.setAutonomy(cfg.campaign.id, { level: "autonomous" }, admin("tatimmah"))).rejects.toThrow(/admin/);
    await engine.setAutonomy(cfg.campaign.id, { level: "assisted", actions: { follow_up: { mode: "autonomous" } } }, admin("dataspeaks"));
    expect(engine.campaign(cfg.campaign.id).autonomy.level).toBe("assisted");
    const trail = await engine.audit.trail({ clientId: "dataspeaks", campaignId: cfg.campaign.id });
    expect(trail.filter((e) => e.event.startsWith("automation.")).map((e) => e.event)).toEqual([
      "automation.change_denied",
      "automation.change_denied",
      "automation.changed",
    ]);
  });
});

describe("replies", () => {
  it("records the next action for each reply, and escalates unclear ones", async () => {
    const { engine, run } = setup([b2bProspect(1), b2bProspect(2)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.example", channel: "email", text: "How much is the pricing?" });
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara2@company2.example", channel: "email", text: "ok" });
    await run();
    const inbound = await engine.store.messages.find((m) => m.direction === "inbound");
    const question = inbound.find((m) => m.intent === "question")!;
    const unclear = inbound.find((m) => m.intent === "other")!;
    expect(question.nextAction).toMatchObject({ kind: "respond" });
    const response = await engine.store.actions.get(question.nextAction!.actionId!);
    expect(String(response!.payload.body)).toContain("Thanks for the question");
    expect(unclear.nextAction?.kind).toBe("escalate");
  });
});

describe("appointments", () => {
  it("tracks a meeting from booking to held, with a sourced brief, and credits the outcome", async () => {
    const { engine, run } = setup([b2bProspect(1, { title: "CEO" }, "sa_enterprise")]);
    const cfg = await loadWith(TATIMMAH, (c) => {
      c.autonomy.level = "autonomous";
      c.escalation.rules = [];
    });
    const id = cfg.campaign.id;
    await engine.registerCampaign(cfg);
    await run();
    await engine.receiveReply({ campaignId: id, from: "sara1@company1.example", channel: "email", text: "Happy to schedule a call" });
    await run();
    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.stage).toBe("positive");

    await engine.recordEvent({ campaignId: id, prospectId: p!.id, type: "meeting.booked", payload: { startsAt: "2026-10-12T07:00:00Z" } });
    let [appt] = await engine.store.appointments.find(() => true);
    expect(appt).toMatchObject({ status: "scheduled", startsAt: "2026-10-12T07:00:00Z", qualifiedAtBooking: true });
    expect(appt!.brief.signals.map((s) => s.source)).toContain("Press release");
    expect(appt!.brief.whyNow.map((w) => w.label)).toEqual(["Active initiative"]);
    expect((await engine.store.prospects.get(p!.id))!.stage).toBe("meeting_booked");

    const { outcome } = await engine.recordEvent({ campaignId: id, prospectId: p!.id, type: "meeting.held" });
    [appt] = await engine.store.appointments.find(() => true);
    expect(appt!.status).toBe("held");
    expect(outcome?.counted).toBe(true);
    expect((await engine.store.prospects.get(p!.id))!.stage).toBe("qualified_meeting");
  });
});

describe("analytics", () => {
  it("breaks outcomes down by configured dimensions and by the opening touch", async () => {
    const { engine, run } = setup([b2bProspect(1), b2bProspect(2, { title: "Head of Performance" })]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.example", channel: "email", text: "interested" });
    await run();
    await engine.recordEvent({ campaignId: cfg.campaign.id, type: "subscription.paid", handle: "sara1@company1.example", payload: { amount: 99 } });

    const analytics = await engine.analytics(cfg.campaign.id);
    const persona = analytics.find((b) => b.key === "persona")!;
    expect(persona.rows.find((r) => r.value === "decision_maker")).toMatchObject({ contacted: 1, positive: 1, outcomes: 1, outcomeRate: 1 });
    expect(persona.rows.find((r) => r.value === "performance_lead")).toMatchObject({ contacted: 1, outcomes: 0 });
    expect(analytics.find((b) => b.key === "channel")!.rows[0]).toMatchObject({ value: "email", outcomes: 1 });
    expect(analytics.map((b) => b.key)).toEqual(["geography", "agency_type", "persona", "tier", "channel", "step", "angle"]);
  });
});
