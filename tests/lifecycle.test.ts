import { describe, expect, it } from "vitest";
import { DATASPEAKS, REAL_ESTATE, TATIMMAH, approver, b2bProspect, loadWith, pending, setup } from "./helpers.js";

describe("end-to-end: paid subscriber campaign under human approval", () => {
  it("discovers, researches, scores, waits for approval, sends, handles reply, converts and reports", async () => {
    const { engine, outbox, run } = setup([b2bProspect(1), b2bProspect(2)]);
    const cfg = await loadWith(DATASPEAKS);
    const id = cfg.campaign.id;
    const user = approver("dataspeaks");
    await engine.registerCampaign(cfg);
    await run();

    // Internal work ran autonomously; nothing external went out without approval.
    const prospects = await engine.store.prospects.find((p) => p.campaignId === id);
    expect(prospects).toHaveLength(2);
    expect(prospects.every((p) => p.research && p.score !== undefined && p.qualification)).toBe(true);
    expect(outbox.sent).toHaveLength(0);
    const sends = await pending(engine, id, "send_message");
    expect(sends).toHaveLength(2);
    expect(String(sends[0]!.payload.body)).toContain("spreadsheet"); // rule-selected snippet
    expect(sends[0]!.payload.unresolved).toEqual([]);

    // Another tick must not duplicate pending work.
    await engine.tick(id);
    await run();
    expect(await pending(engine, id, "send_message")).toHaveLength(2);

    for (const a of sends) await engine.approve(a.id, user);
    await run();
    expect(outbox.sent).toHaveLength(2);

    await engine.receiveReply({ campaignId: id, from: "sara1@company1.sa", channel: "email", text: "Yes, interested — happy to try a trial" });
    await run();
    const p1 = (await engine.store.prospects.find((p) => p.lastIntent === "interested"))[0]!;
    expect(p1.qualification?.qualified).toBe(true);
    expect(p1.stage).toBe("trial_ready");
    expect(p1.sequence.stopped).toBe(true);

    const conversion = await pending(engine, id, "conversion_step");
    expect(conversion).toHaveLength(1);
    await engine.approve(conversion[0]!.id, user);
    await run();
    expect(outbox.sent.at(-1)!.body).toContain("trial link");

    const { outcome } = await engine.recordEvent({ campaignId: id, type: "subscription.paid", handle: "sara1@company1.sa", payload: { amount: 149 } });
    expect(outcome?.counted).toBe(true);
    expect(outcome?.value).toEqual({ amount: 149, currency: "USD", recurrence: "monthly" });
    expect(outcome?.attribution.firstTouch?.stepKey).toBe("s1_intro");

    const report = await engine.report(id);
    expect(report.outcome).toMatchObject({ key: "paid_subscriber", achieved: 1, target: 50, progressPct: 2, value: { amount: 149 } });
    expect(report.pipeline.find((s) => s.stage === "subscribed")?.count).toBe(1);
    expect(report.attribution.byChannel).toEqual({ email: 1 });
    expect(report.activity).toMatchObject({ prospects: 2, contacted: 2, replied: 1, positiveReplies: 1 });

    // Every decision is on the audit trail.
    const trail = await engine.audit.trail({ clientId: "dataspeaks", actionId: sends[0]!.id });
    expect(trail.map((e) => e.event)).toEqual(["action.proposed", "action.pending_approval", "action.approved", "action.succeeded"]);
  });
});

describe("qualified meeting campaign", () => {
  it("does not count a meeting with an unqualified prospect and raises an exception", async () => {
    const { engine, run } = setup([b2bProspect(1, { title: "Analyst" })]);
    const cfg = await loadWith(TATIMMAH);
    await engine.registerCampaign(cfg);
    await run();
    const { outcome } = await engine.recordEvent({ campaignId: cfg.campaign.id, type: "meeting.held", handle: "sara1@company1.sa" });
    expect(outcome?.counted).toBe(false);
    const report = await engine.report(cfg.campaign.id);
    expect(report.outcome).toMatchObject({ achieved: 0, uncounted: 1 });
    expect(report.attention.exceptions.map((e) => e.kind)).toContain("unqualified_outcome");
  });

  it("answers a meeting request, then sends the booking link once qualified, and credits the held meeting", async () => {
    const { engine, outbox, run } = setup([b2bProspect(1, { title: "CEO" })]);
    const cfg = await loadWith(TATIMMAH, (c) => {
      c.autonomy.level = "autonomous";
      c.escalation.rules = [];
    });
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(1); // intro, channel picked automatically

    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.sa", channel: "email", text: "Happy to schedule a call next week" });
    await run();
    const bodies = outbox.sent.map((m) => m.body);
    expect(bodies.some((b) => b.includes("booking link shortly"))).toBe(true);
    expect(bodies.some((b) => b.includes("tatimmah.example/book"))).toBe(true);

    const { outcome } = await engine.recordEvent({ campaignId: cfg.campaign.id, type: "meeting.held", handle: "sara1@company1.sa" });
    expect(outcome?.counted).toBe(true);
    expect((await engine.report(cfg.campaign.id)).outcome.achieved).toBe(1);
  });
});

describe("new industry by configuration only", () => {
  it("runs the real-estate qualified-lead template on the same engine", async () => {
    const { engine, outbox, run } = setup([
      {
        contact: {
          firstName: "Khalid",
          city: "Riyadh",
          handles: { phone: "+966500000001", email: "khalid@example.com" },
          consents: ["whatsapp"],
          attributes: { buyer_type: "investor", budget: 2_000_000, timeline: "0-3m", target_area: "North Riyadh" },
        },
      },
      {
        contact: {
          firstName: "Noura",
          city: "Jeddah",
          handles: { phone: "+966500000002" }, // no consent, no email → unreachable
          attributes: { buyer_type: "end_user" },
        },
      },
    ]);
    const cfg = await loadWith(REAL_ESTATE, (c) => {
      c.campaign.status = "active";
      c.autonomy.level = "autonomous";
    });
    await engine.registerCampaign(cfg);
    await run();

    expect(outbox.sent).toHaveLength(1);
    expect(outbox.sent[0]).toMatchObject({ channel: "whatsapp", to: "+966500000001" });
    const blocked = await engine.store.actions.find((a) => a.status === "blocked" && a.type === "send_message");
    expect(blocked[0]?.lastError).toMatch(/consent/);

    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "+966500000001", channel: "whatsapp", text: "مهتم، أرسل التفاصيل" });
    await run();
    const khalid = (await engine.store.prospects.find((p) => p.lastIntent === "interested"))[0]!;
    expect(khalid.persona).toBe("investor");
    expect(khalid.qualification?.qualified).toBe(true);

    const { outcome } = await engine.recordEvent({ campaignId: cfg.campaign.id, type: "lead.verified", prospectId: khalid.id });
    expect(outcome?.counted).toBe(true);
    const report = await engine.report(cfg.campaign.id);
    expect(report.outcome).toMatchObject({ key: "qualified_lead", unit: "lead", achieved: 1 });
  });
});
