import { describe, expect, it } from "vitest";
import { OutboxSender, TransientError, type OutboundMessage } from "../src/index.js";
import { DATASPEAKS, DAY, HOUR, START, approver, b2bProspect, loadWith, pending, setup } from "./helpers.js";

const many = (n: number) => Array.from({ length: n }, (_, i) => b2bProspect(i + 1));

describe("autonomy levels are configuration, not code", () => {
  it.each([
    ["human_approval", 0, 1],
    ["assisted", 1, 0],
    ["autonomous", 1, 0],
  ] as const)("%s: sent=%i pending=%i", async (level, sent, pendingCount) => {
    const { engine, outbox, run } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = level));
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(sent);
    expect(await pending(engine, cfg.campaign.id, "send_message")).toHaveLength(pendingCount);
  });

  it("assisted mode routes low-confidence messages to a human", async () => {
    // No firstName fallback in this template → unresolved placeholder → low confidence.
    const { engine, outbox, run } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => {
      c.autonomy.level = "assisted";
      c.personalization.templates.intro = { variants: [{ key: "v", body: "Hi {{contact.nickname}}" }] };
    });
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(0);
    const [action] = await pending(engine, cfg.campaign.id, "send_message");
    expect(action!.confidence).toBeLessThan(0.85);
    const trail = await engine.audit.trail({ clientId: "dataspeaks", actionId: action!.id });
    expect(trail.find((e) => e.event === "action.pending_approval")?.detail.reason).toMatch(/confidence/);
  });

  it("per-action overrides and permissions: disabled action is blocked", async () => {
    const { engine, outbox, run } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => {
      c.autonomy.level = "autonomous";
      c.autonomy.allowedActions = ["discover", "research", "score", "qualify"];
    });
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(0);
    const [blocked] = await engine.store.actions.find((a) => a.type === "send_message");
    expect(blocked).toMatchObject({ status: "blocked", lastError: expect.stringMatching(/not permitted/) });
  });
});

describe("constraints", () => {
  it("rate limits defer excess sends to the next window", async () => {
    const { engine, outbox, run, advance } = setup(many(5));
    const cfg = await loadWith(DATASPEAKS, (c) => {
      c.autonomy.level = "autonomous";
      c.constraints.rateLimits = [{ action: "send_message", channel: "email", perHour: 2 }];
    });
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(2);
    expect(await engine.store.actions.find((a) => a.status === "scheduled")).toHaveLength(3);
    await advance(HOUR);
    expect(outbox.sent).toHaveLength(4);
    await advance(HOUR);
    expect(outbox.sent).toHaveLength(5);
  });

  it("quiet hours defer sends until the window opens", async () => {
    const { engine, outbox, run, clock } = setup([b2bProspect(1)]);
    clock.set(new Date("2026-10-04T20:00:00Z")); // 23:00 Riyadh
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent).toHaveLength(0);
    const [scheduled] = await engine.store.actions.find((a) => a.status === "scheduled");
    expect(scheduled!.runAfter).toBe("2026-10-05T05:00:00.000Z"); // 08:00 Riyadh
    clock.set(new Date("2026-10-05T05:00:00Z"));
    await run();
    expect(outbox.sent).toHaveLength(1);
  });

  it("follows the sequence schedule and stops when the prospect replies", async () => {
    const { engine, outbox, run, advance } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    expect(outbox.sent.map((m) => m.channel)).toEqual(["email"]);
    await advance(2 * DAY);
    expect(outbox.sent.map((m) => m.channel)).toEqual(["email", "linkedin"]);
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.sa", channel: "email", text: "not now, maybe next quarter" });
    await run();
    await advance(20 * DAY);
    expect(outbox.sent).toHaveLength(2);
  });

  it("opt-out suppresses the contact and blocks anything already queued", async () => {
    const { engine, outbox, run, advance } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.sa", channel: "email", text: "Please unsubscribe me" });
    await run();
    await advance(30 * DAY);
    expect(outbox.sent).toHaveLength(1);
    const contact = (await engine.store.contacts.find(() => true))[0]!;
    expect(contact.suppressed).toBe(true);
  });
});

describe("retries, failures and escalation", () => {
  it("retries transient failures with backoff", async () => {
    let calls = 0;
    const flaky = new OutboxSender();
    const channel = {
      async send(msg: OutboundMessage) {
        if (++calls < 3) throw new TransientError("429 too many requests");
        return flaky.send(msg);
      },
    };
    const { engine, run, advance } = setup([b2bProspect(1)], { channels: { email: channel, linkedin: channel } });
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    expect(flaky.sent).toHaveLength(0);
    await advance(120_000); // first backoff
    await advance(240_000); // second backoff (x2)
    expect(flaky.sent).toHaveLength(1);
    const [action] = await engine.store.actions.find((a) => a.type === "send_message");
    expect(action).toMatchObject({ status: "succeeded", attempts: 3 });
  });

  it("permanent failure pauses the prospect and surfaces an exception", async () => {
    const broken = { send: async () => Promise.reject(new Error("mailbox does not exist")) };
    const { engine, run } = setup([b2bProspect(1)], { channels: { email: broken, linkedin: broken } });
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.status).toBe("paused");
    const report = await engine.report(cfg.campaign.id);
    expect(report.attention.exceptions[0]).toMatchObject({ kind: "action_failed", severity: "high" });

    await engine.resolveException(report.attention.exceptions[0]!.id, approver("dataspeaks"), { resumeProspect: true });
    expect((await engine.store.prospects.get(p!.id))!.status).toBe("active");
  });

  it("escalation rules pause the prospect for a human", async () => {
    const { engine, outbox, run } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS, (c) => (c.autonomy.level = "autonomous"));
    await engine.registerCampaign(cfg);
    await run();
    await engine.receiveReply({ campaignId: cfg.campaign.id, from: "sara1@company1.sa", channel: "email", text: "Interested, but we need an enterprise contract and a discount" });
    await run();
    const [p] = await engine.store.prospects.find(() => true);
    expect(p!.status).toBe("paused");
    expect(outbox.sent).toHaveLength(1); // no automatic conversion step while escalated
    const report = await engine.report(cfg.campaign.id);
    expect(report.attention.exceptions.map((e) => e.reason)).toContain("Commercial negotiation — needs a human.");
  });
});

describe("permissions and tenant isolation", () => {
  it("only approvers of the owning client can decide on actions", async () => {
    const { engine, run } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS);
    await engine.registerCampaign(cfg);
    await run();
    const [action] = await pending(engine, cfg.campaign.id, "send_message");
    await expect(engine.approve(action!.id, approver("tatimmah"))).rejects.toThrow(/not permitted/);
    await expect(engine.approve(action!.id, { type: "user", id: "v", clientId: "dataspeaks", roles: ["viewer"] })).rejects.toThrow(/not permitted/);
    await engine.reject(action!.id, approver("dataspeaks"), "wrong tone");
    const trail = await engine.audit.trail({ clientId: "dataspeaks", actionId: action!.id });
    expect(trail.map((e) => e.event)).toContain("action.decision_denied");
    expect(trail.at(-1)).toMatchObject({ event: "action.rejected", detail: { reason: "wrong tone" } });
  });

  it("a rejected touch is skipped and the sequence continues later", async () => {
    const { engine, run, advance } = setup([b2bProspect(1)]);
    const cfg = await loadWith(DATASPEAKS);
    await engine.registerCampaign(cfg);
    await run();
    const [first] = await pending(engine, cfg.campaign.id, "send_message");
    await engine.reject(first!.id, approver("dataspeaks"), "not yet");
    await run();
    await advance(2 * DAY);
    const next = await pending(engine, cfg.campaign.id, "send_message");
    expect(next.map((a) => a.payload.stepKey)).toEqual(["s2_linkedin"]);
  });
});

describe("learning loop", () => {
  it("detects an underperforming variant and applies the change once approved", async () => {
    const { engine, run, clock } = setup(many(40));
    const cfg = await loadWith(DATASPEAKS, (c) => {
      c.autonomy.level = "autonomous";
      c.autonomy.actions = { optimize: { mode: "approval" } };
      c.optimization.minSampleSize = 10;
      c.constraints.rateLimits = [];
      c.discovery.targetActivePool = 40;
      c.discovery.batchSize = 40;
    });
    const id = cfg.campaign.id;
    await engine.registerCampaign(cfg);
    await run();

    const intro = await engine.store.messages.find((m) => m.stepKey === "s1_intro");
    expect(new Set(intro.map((m) => m.variantKey))).toEqual(new Set(["pain_led", "question_led"]));
    // Everyone who got the pain-led variant replies positively.
    for (const m of intro.filter((m) => m.variantKey === "pain_led")) {
      const p = (await engine.store.prospects.get(m.prospectId))!;
      const contact = (await engine.store.contacts.get(p.contactId))!;
      await engine.receiveReply({ campaignId: id, from: contact.handles.email, channel: "email", text: "interested!" });
    }
    await run();

    clock.set(new Date(START.getTime() + 25 * HOUR));
    await engine.tick(id);
    await run();
    const [opt] = await pending(engine, id, "optimize");
    expect(opt).toBeDefined();
    const report = await engine.report(id);
    expect(report.recommendations[0]!.summary).toMatch(/Retire variant 'question_led'/);

    await engine.approve(opt!.id, approver("dataspeaks"));
    await run();
    const state = await engine.store.campaignState.get(id);
    expect(state!.disabledVariants).toEqual(["intro:question_led"]);
  });
});

describe("optimizer hygiene", () => {
  it("a newer recommendation on the same template supersedes the open one", async () => {
    const { engine, run, clock } = setup(many(40));
    const cfg = await loadWith(DATASPEAKS, (c) => {
      c.autonomy.level = "autonomous";
      c.autonomy.actions = { optimize: { mode: "approval" } };
      c.optimization.minSampleSize = 10;
      c.constraints.rateLimits = [];
      c.discovery.targetActivePool = 40;
      c.discovery.batchSize = 40;
    });
    const id = cfg.campaign.id;
    await engine.registerCampaign(cfg);
    await run();

    // A stale open recommendation (from older evidence) to retire the other variant.
    await engine.store.recommendations.put({
      id: "rec_stale", clientId: "dataspeaks", campaignId: id, kind: "variant_underperforming",
      summary: "Retire variant 'pain_led' of 'intro'", evidence: {},
      change: { op: "disable_variant", templateKey: "intro", variantKey: "pain_led" }, status: "open", at: START.toISOString(),
    });
    const stale = await engine.gateway.propose({
      clientId: "dataspeaks", campaignId: id, type: "optimize", idempotencyKey: "optimize:rec_stale",
      payload: { recommendationId: "rec_stale" }, confidence: 0.8, rationale: "stale", actor: { type: "agent", id: "test" },
    });
    expect(stale.status).toBe("pending_approval");

    // New evidence: pain_led converts, question_led does not.
    const intro = await engine.store.messages.find((m) => m.stepKey === "s1_intro");
    for (const m of intro.filter((m) => m.variantKey === "pain_led")) {
      const p = (await engine.store.prospects.get(m.prospectId))!;
      const contact = (await engine.store.contacts.get(p.contactId))!;
      await engine.receiveReply({ campaignId: id, from: contact.handles.email, channel: "email", text: "interested!" });
    }
    await run();
    clock.set(new Date(START.getTime() + 25 * HOUR));
    await engine.tick(id);
    await run();

    const recs = await engine.store.recommendations.find((r) => r.campaignId === id);
    expect(recs.filter((r) => r.status === "open").map((r) => r.summary)).toEqual([expect.stringMatching(/Retire variant 'question_led'/)]);
    expect(recs.find((r) => r.id === "rec_stale")!.status).toBe("dismissed");
    expect((await engine.store.actions.get(stale.id))!.status).toBe("cancelled");
    expect(await pending(engine, id, "optimize")).toHaveLength(1);
  });
});
