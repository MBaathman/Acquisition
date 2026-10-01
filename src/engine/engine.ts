import { TOUCH_ACTIONS, type ActionType, type AutonomyLevel } from "../config/actions.js";
import { evaluate, getPath } from "../config/evaluate.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Adapters, Clock } from "../adapters/ports.js";
import type {
  Account,
  Action,
  Appointment,
  Actor,
  Attributes,
  CampaignState,
  Contact,
  EventRecord,
  Message,
  OutcomeRecord,
  Prospect,
  Recommendation,
  ResearchSignal,
  TouchRef,
} from "../domain/types.js";
import { createMemoryStore, type Store } from "../store/store.js";
import { InMemoryQueue, type JobQueue } from "../runtime/queue.js";
import { newId } from "../runtime/ids.js";
import { AGENT_ACTOR, AuditLog, SYSTEM_ACTOR } from "../governance/audit.js";
import { ActionGateway } from "../governance/gateway.js";
import { buildContext, reachMilestone } from "../agents/context.js";
import { qualify, scoreProspect } from "../agents/scoring.js";
import { renderVariant } from "../agents/personalization.js";
import { computeStats, proposeOptimizations, selectChannel, selectVariant } from "../agents/learning.js";
import { buildClientReport } from "../reporting/client-report.js";
import { buildAnalytics } from "../reporting/analytics.js";
import { buildBrief } from "../agents/brief.js";
import { reachableChannels } from "../agents/learning.js";

const DAY = 86_400_000;
const ACTIVE_STATUSES = new Set(["active", "paused"]);
const IN_FLIGHT = new Set(["pending_approval", "approved", "scheduled", "executing"]);

/**
 * The Acquisition Engine: a continuously running, campaign-agnostic loop.
 *
 *   campaign.tick (recurring job)
 *     ├─ discover     top up the prospect pool from the configured source
 *     ├─ prospect.advance for each active prospect
 *     │    research → score → qualify → [conversion step] → next sequence touch
 *     └─ optimize     learn from results, propose/apply improvements
 *   reply.process  (on inbound message)  classify → escalate → respond → re-qualify
 *   recordEvent    (webhooks: payment, booking, form...) → outcome + attribution
 *
 * Every step an agent takes is an Action routed through the ActionGateway,
 * which applies permissions, policies, rate limits, confidence thresholds,
 * the campaign's autonomy level, retries, audit logging and escalation.
 */
export class AcquisitionEngine {
  readonly store: Store;
  readonly queue: JobQueue;
  readonly audit: AuditLog;
  readonly gateway: ActionGateway;
  private readonly clock: Clock;
  private readonly campaigns = new Map<string, CampaignConfig>();

  constructor(private readonly adapters: Adapters, opts: { store?: Store; queue?: JobQueue } = {}) {
    this.clock = adapters.clock;
    this.store = opts.store ?? createMemoryStore();
    this.queue = opts.queue ?? new InMemoryQueue(() => this.clock.now());
    this.audit = new AuditLog(this.store, this.clock);
    this.gateway = new ActionGateway({
      store: this.store,
      clock: this.clock,
      queue: this.queue,
      audit: this.audit,
      campaign: (id) => this.campaign(id),
      hooks: {
        onSucceeded: (a) => this.afterAction(a),
        onClosed: (a) => this.afterActionClosed(a),
      },
    });

    this.gateway.handle("discover", (a, cfg) => this.runDiscovery(a, cfg));
    this.gateway.handle("research", (a, cfg) => this.runResearch(a, cfg));
    this.gateway.handle("score", (a, cfg) => this.runScoring(a, cfg));
    this.gateway.handle("enrich_contact", (a, cfg) => this.runContactFinding(a, cfg));
    this.gateway.handle("qualify", (a, cfg) => this.runQualification(a, cfg));
    this.gateway.handle("send_message", (a, cfg) => this.deliver(a, cfg));
    this.gateway.handle("follow_up", (a, cfg) => this.deliver(a, cfg));
    this.gateway.handle("respond", (a, cfg) => this.deliver(a, cfg));
    this.gateway.handle("conversion_step", (a, cfg) => this.deliver(a, cfg));
    this.gateway.handle("optimize", (a) => this.applyOptimization(a));

    this.queue.register("campaign.tick", (p) => this.tick(String(p.campaignId)));
    this.queue.register("prospect.advance", (p) => this.advance(String(p.prospectId)));
    this.queue.register("reply.process", (p) => this.processReply(String(p.messageId)));
  }

  // -------------------------------------------------------------------------
  // Campaign lifecycle
  // -------------------------------------------------------------------------

  async registerCampaign(cfg: CampaignConfig): Promise<void> {
    const existing = this.campaigns.get(cfg.campaign.id);
    if (existing && existing.client.id !== cfg.client.id) {
      throw new Error(`campaign id '${cfg.campaign.id}' already belongs to another client`);
    }
    this.campaigns.set(cfg.campaign.id, cfg);
    if (!(await this.store.campaignState.get(cfg.campaign.id))) {
      await this.store.campaignState.put({ id: cfg.campaign.id, clientId: cfg.client.id, disabledVariants: [] });
    }
    await this.audit.record({ clientId: cfg.client.id, campaignId: cfg.campaign.id, actor: SYSTEM_ACTOR, event: "campaign.registered", detail: { status: cfg.campaign.status, autonomy: cfg.autonomy.level, outcome: cfg.outcome.key } });
    if (cfg.campaign.status === "active") await this.scheduleTick(cfg, this.clock.now());
  }

  campaign(id: string): CampaignConfig {
    const cfg = this.campaigns.get(id);
    if (!cfg) throw new Error(`unknown campaign '${id}'`);
    return cfg;
  }

  campaignsFor(clientId: string): CampaignConfig[] {
    return [...this.campaigns.values()].filter((c) => c.client.id === clientId);
  }

  private async scheduleTick(cfg: CampaignConfig, at: Date) {
    await this.queue.enqueue("campaign.tick", { campaignId: cfg.campaign.id }, { runAt: at, dedupeKey: `tick:${cfg.campaign.id}:${at.getTime()}` });
  }

  private async state(campaignId: string): Promise<CampaignState> {
    const s = await this.store.campaignState.get(campaignId);
    if (!s) throw new Error(`no state for campaign '${campaignId}'`);
    return s;
  }

  /** Recurring background loop for one campaign. */
  async tick(campaignId: string): Promise<void> {
    const cfg = this.campaign(campaignId);
    if (cfg.campaign.status !== "active") return;
    const now = this.clock.now();
    const clientId = cfg.client.id;
    const state = await this.state(campaignId);

    const prospects = await this.store.prospects.find((p) => p.campaignId === campaignId);
    const activeCount = prospects.filter((p) => p.status === "active").length;
    const room = cfg.discovery.targetActivePool - activeCount;
    if (room > 0 && !state.sourceExhausted) {
      const bucket = Math.floor(now.getTime() / (cfg.scheduling.tickMinutes * 60_000));
      await this.gateway.propose({
        clientId, campaignId, type: "discover", idempotencyKey: `discover:${bucket}`,
        payload: { limit: Math.min(room, cfg.discovery.batchSize) },
        confidence: 1, rationale: `active pool ${activeCount}/${cfg.discovery.targetActivePool}`, actor: AGENT_ACTOR,
      });
    }

    for (const p of prospects.filter((p) => p.status === "active")) {
      await this.queue.enqueue("prospect.advance", { prospectId: p.id }, { dedupeKey: `advance:${p.id}` });
    }

    if (cfg.optimization.enabled) {
      const last = state.lastOptimizedAt ? new Date(state.lastOptimizedAt).getTime() : 0;
      if (now.getTime() - last >= cfg.optimization.cadenceHours * 3_600_000) await this.optimize(cfg);
    }

    await this.scheduleTick(cfg, new Date(now.getTime() + cfg.scheduling.tickMinutes * 60_000));
  }

  // -------------------------------------------------------------------------
  // Planner: decides the next governed action for a prospect
  // -------------------------------------------------------------------------

  async advance(prospectId: string): Promise<void> {
    const p = await this.store.prospects.get(prospectId);
    if (!p || p.status !== "active") return;
    const cfg = this.campaign(p.campaignId);
    if (cfg.campaign.status !== "active") return;
    const base = { clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR };

    if (!p.research) {
      const action = await this.gateway.propose({ ...base, type: "research", idempotencyKey: `research:${p.id}`, confidence: 1, rationale: "new prospect" });
      if (["approved", "scheduled", "executing", "pending_approval"].includes(action.status) && p.researchStatus === "needs_research") {
        const fresh = (await this.store.prospects.get(p.id))!;
        if (!fresh.research) {
          fresh.researchStatus = "researching";
          await this.saveProspect(fresh);
        }
      }
      return;
    }
    if (p.score === undefined) {
      await this.gateway.propose({ ...base, type: "score", idempotencyKey: `score:${p.id}`, confidence: 1, rationale: "research complete" });
      return;
    }
    if (p.milestones.fit && !p.milestones.contacted && p.contactStatus !== "found") {
      const contact = (await this.store.contacts.get(p.contactId))!;
      if (reachableChannels(cfg, contact).length) {
        p.contactStatus = "found";
        await this.saveProspect(p);
      } else if (p.contactStatus === "needs_contact" && cfg.contacts.finder) {
        await this.gateway.propose({ ...base, type: "enrich_contact", idempotencyKey: `enrich:${p.id}`, confidence: 1, rationale: "fit prospect without a reachable handle" });
        return;
      } else if (p.contactStatus !== "finding") {
        p.status = "parked";
        p.attributes.parkedReason = "no_contact";
        await this.saveProspect(p);
        return;
      } else return;
    }
    if (!p.qualification) {
      await this.gateway.propose({ ...base, type: "qualify", idempotencyKey: `qualify:${p.id}:initial`, confidence: 1, rationale: "initial qualification" });
      return;
    }

    const conversion = cfg.outcome.conversionStep;
    if (conversion && p.qualification.qualified && !p.attributes.conversionStepAt) {
      // Continue on the channel the prospect last replied on, unless the config pins one.
      const lastInbound = (await this.store.messages.find((m) => m.prospectId === p.id && m.direction === "inbound"))
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1);
      const composed = await this.compose(cfg, p, conversion.template, conversion.channel ?? lastInbound?.channel ?? "auto");
      const action = await this.gateway.propose({
        ...base, type: "conversion_step", idempotencyKey: `conversion:${p.id}`,
        payload: { ...composed.payload, kind: "conversion" }, confidence: composed.confidence,
        rationale: `qualified (${p.qualification.met.join(", ")}); moving to ${cfg.outcome.label}`,
      });
      if (lastInbound && !lastInbound.nextAction?.actionId && lastInbound.nextAction?.kind !== "escalate") {
        lastInbound.nextAction = { kind: "conversion_step", summary: `send ${conversion.template}`, actionId: action.id };
        await this.store.messages.put(lastInbound);
      }
      if (!["rejected", "blocked"].includes(action.status)) return;
    }

    await this.planSequence(cfg, p);
  }

  private async planSequence(cfg: CampaignConfig, p: Prospect) {
    if (p.sequence.stopped) return;
    const state = await this.state(p.campaignId);
    const minScore = state.minScoreOverride ?? cfg.outreach.minScore;
    if (!p.milestones.contacted && (p.score ?? 0) < minScore) {
      p.status = "parked";
      await this.saveProspect(p);
      return;
    }

    const now = this.clock.now();
    const steps = cfg.outreach.sequence;
    let idx = p.sequence.nextStepIndex;
    const ctx = await this.context(cfg, p);
    const contact = (await this.store.contacts.get(p.contactId))!;
    const reachable = reachableChannels(cfg, contact);
    const skippable = (st: (typeof steps)[number]) =>
      (st.when && !evaluate(st.when, ctx)) || (st.channel !== "auto" && !reachable.includes(st.channel));
    while (idx < steps.length && skippable(steps[idx]!)) {
      await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR, event: "sequence.step_skipped", detail: { step: steps[idx]!.key, reason: steps[idx]!.channel !== "auto" && !reachable.includes(steps[idx]!.channel) ? "channel_unreachable" : "condition_not_met" } });
      idx++;
    }
    if (idx !== p.sequence.nextStepIndex) {
      p.sequence.nextStepIndex = idx;
      await this.saveProspect(p);
    }
    const step = steps[idx];
    if (!step || p.touches >= cfg.constraints.maxTouchesPerProspect) {
      if (!p.milestones.engaged) {
        p.status = "exhausted";
        await this.saveProspect(p);
      }
      return;
    }

    if (!p.sequence.startedAt) {
      // Anchor the sequence timeline when outreach first becomes eligible, so a
      // skipped or rejected touch does not push later steps back.
      p.sequence.startedAt = now.toISOString();
      await this.saveProspect(p);
    }
    const due = new Date(new Date(p.sequence.startedAt).getTime() + step.dayOffset * DAY);
    if (due > now) {
      await this.queue.enqueue("prospect.advance", { prospectId: p.id }, { runAt: due, dedupeKey: `advance:${p.id}:${due.getTime()}` });
      return;
    }

    const composed = await this.compose(cfg, p, step.template, step.channel);
    await this.gateway.propose({
      clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR,
      type: p.milestones.contacted ? "follow_up" : "send_message", idempotencyKey: `send:${p.id}:${step.key}`,
      payload: { ...composed.payload, kind: "sequence", stepKey: step.key },
      confidence: composed.confidence,
      rationale: `sequence step '${step.key}' (tier ${p.tier}, score ${p.score})`,
    });
  }

  /**
   * Draft of the prospect's next sequence touch, composed now but not proposed
   * (it is proposed through the gateway when it falls due).
   */
  async previewNextTouch(prospectId: string) {
    const p = await this.store.prospects.get(prospectId);
    if (!p || p.status !== "active" || p.sequence.stopped || !p.sequence.startedAt) return undefined;
    const cfg = this.campaign(p.campaignId);
    const step = cfg.outreach.sequence[p.sequence.nextStepIndex];
    if (!step || p.touches >= cfg.constraints.maxTouchesPerProspect) return undefined;
    const due = new Date(new Date(p.sequence.startedAt).getTime() + step.dayOffset * DAY);
    if (due <= this.clock.now()) return undefined;
    const composed = await this.compose(cfg, p, step.template, step.channel);
    return { prospectId: p.id, stepKey: step.key, dueAt: due.toISOString(), confidence: composed.confidence, ...composed.payload };
  }

  /** Personalize a template for a prospect, selecting channel and variant from learned stats. */
  private async compose(cfg: CampaignConfig, p: Prospect, templateKey: string, requestedChannel: string, extra?: Attributes) {
    const contact = (await this.store.contacts.get(p.contactId))!;
    const ctx = await this.context(cfg, p, extra);
    const stats = await this.stats(cfg);
    const state = await this.state(p.campaignId);
    const channel = selectChannel(cfg, contact, requestedChannel, stats);
    const variant = selectVariant(cfg, state, templateKey, stats);
    let { subject, body, unresolved } = renderVariant(variant, ctx, cfg);

    const researchConfidence = cfg.research.questions.length ? p.research?.confidence ?? 0 : 1;
    let confidence = Math.min(researchConfidence, unresolved.length ? 0.4 : 1);
    if (this.adapters.composer) {
      const rewritten = await this.adapters.composer.compose({ campaign: cfg, rendered: { subject, body }, context: ctx });
      ({ subject, body } = rewritten);
      confidence = Math.min(confidence, rewritten.confidence);
    }
    const handleKey = cfg.outreach.channels.find((c) => c.key === channel)?.handle ?? "";
    return {
      confidence,
      payload: { channel, to: contact.handles[handleKey], subject, body, templateKey, variantKey: variant.key, unresolved } as Attributes,
    };
  }

  // -------------------------------------------------------------------------
  // Action handlers (run by the gateway after governance checks)
  // -------------------------------------------------------------------------

  private async runDiscovery(action: Action, cfg: CampaignConfig) {
    const source = this.adapters.sources[cfg.discovery.source];
    if (!source) throw new Error(`no prospect source registered as '${cfg.discovery.source}'`);
    const state = await this.state(cfg.campaign.id);
    const { prospects, cursor } = await source.discover({
      campaign: cfg, query: cfg.discovery.query, limit: Number(action.payload.limit), cursor: state.discoveryCursor,
    });
    state.discoveryCursor = cursor;
    state.sourceExhausted = prospects.length === 0;
    await this.store.campaignState.put(state);

    let added = 0;
    let skipped = 0;
    const now = this.clock.now().toISOString();
    const clientId = cfg.client.id;
    for (const d of prospects) {
      const handles = Object.values(d.contact.handles).map((h) => h.toLowerCase());
      let contact = await this.store.contacts.findOne(
        (c) => c.clientId === clientId && Object.values(c.handles).some((h) => handles.includes(h.toLowerCase())),
      );
      if (contact) {
        const enrolled = await this.store.prospects.find((p) => p.contactId === contact!.id);
        if (enrolled.some((p) => p.campaignId === cfg.campaign.id) || (cfg.discovery.dedupeAcrossCampaigns && enrolled.length)) {
          skipped++;
          continue;
        }
      }
      let account: Account | undefined;
      if (d.account) {
        account = d.account.domain
          ? await this.store.accounts.findOne((a) => a.clientId === clientId && a.domain === d.account!.domain)
          : undefined;
        if (!account) {
          account = { attributes: {}, externalIds: {}, ...d.account, id: newId("acc"), clientId };
          await this.store.accounts.put(account);
        }
      }
      if (!contact) {
        contact = {
          consents: [], suppressed: false, attributes: {}, externalIds: {},
          ...d.contact, id: newId("con"), clientId, accountId: account?.id,
        };
        await this.store.contacts.put(contact);
      }
      const prospect: Prospect = {
        id: newId("pro"), clientId, campaignId: cfg.campaign.id, contactId: contact.id, accountId: account?.id,
        status: "active", stage: cfg.funnel.stages[0]!.key, milestones: {},
        researchStatus: "needs_research", contactStatus: reachableChannels(cfg, contact).length ? "found" : "needs_contact",
        sequence: { nextStepIndex: 0, stopped: false }, touches: 0, attributes: {}, createdAt: now, updatedAt: now,
      };
      reachMilestone(prospect, cfg, "discovered", now);
      await this.store.prospects.put(prospect);
      await this.queue.enqueue("prospect.advance", { prospectId: prospect.id }, { dedupeKey: `advance:${prospect.id}` });
      added++;
    }
    return { added, skipped };
  }

  /**
   * Research keeps only findings that cite a source. Unsourced answers are
   * discarded (never used for scoring or copy) and the prospect is flagged
   * for review when required answers are missing or confidence is low.
   */
  private async runResearch(action: Action, cfg: CampaignConfig) {
    const p = await this.requireProspect(action);
    const contact = (await this.store.contacts.get(p.contactId))!;
    const account = p.accountId ? await this.store.accounts.get(p.accountId) : undefined;
    const questions = cfg.research.questions;
    const provider = this.adapters.research[cfg.research.provider];
    if (questions.length && !provider) throw new Error(`no research provider registered as '${cfg.research.provider}'`);
    const { findings } = questions.length && provider
      ? await provider.research({ campaign: cfg, account, contact, questions })
      : { findings: [] };
    const now = this.clock.now().toISOString();
    const asked = new Set(questions.map((q) => q.key));
    const signals: ResearchSignal[] = [];
    const rejected: string[] = [];
    for (const f of findings) {
      if (!asked.has(f.key) || f.value === undefined || f.value === null || f.value === "") continue;
      if (!f.source) {
        rejected.push(f.key);
        continue;
      }
      signals.push({ key: f.key, value: f.value, source: f.source, url: f.url, confidence: f.confidence ?? 0.8, at: now });
    }
    const answers = Object.fromEntries(signals.map((sig) => [sig.key, sig.value]));
    const required = questions.filter((q) => q.required);
    const missing = required.filter((q) => answers[q.key] === undefined).map((q) => q.key);
    // Confidence reflects required coverage; optional questions add signal but never penalise.
    const coverage = required.length ? (required.length - missing.length) / required.length : 1;
    const meanConfidence = signals.length ? signals.reduce((sum, sig) => sum + sig.confidence, 0) / signals.length : questions.length ? 0 : 1;
    const confidence = Math.round(coverage * meanConfidence * 100) / 100;

    p.research = { answers, signals, missing, rejected, confidence, at: now };
    p.researchStatus = missing.length || rejected.length || confidence < cfg.research.minConfidence ? "needs_review" : "complete";
    for (const q of questions) {
      if (q.mapsTo && answers[q.key] !== undefined) p.attributes[q.mapsTo] = answers[q.key];
    }
    reachMilestone(p, cfg, "researched", now);
    await this.saveProspect(p);
    await this.audit.record({
      clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actionId: action.id, actor: AGENT_ACTOR, event: "research.completed",
      detail: { status: p.researchStatus, signals: signals.length, missing, rejectedUnsourced: rejected, confidence },
    });
    return { signals: signals.length, missing: missing.length, rejected: rejected.length, confidence };
  }

  private async runContactFinding(action: Action, cfg: CampaignConfig) {
    const p = await this.requireProspect(action);
    const finder = cfg.contacts.finder ? this.adapters.contactFinders?.[cfg.contacts.finder] : undefined;
    if (!finder) throw new Error(`no contact finder registered as '${cfg.contacts.finder}'`);
    const contact = (await this.store.contacts.get(p.contactId))!;
    const account = p.accountId ? await this.store.accounts.get(p.accountId) : undefined;
    const found = await finder.find({ campaign: cfg, account, contact });
    if (found.source && Object.keys(found.handles).length) {
      contact.handles = { ...contact.handles, ...found.handles };
      contact.externalIds = { ...contact.externalIds, handleSource: found.source };
      await this.store.contacts.put(contact);
    }
    p.contactStatus = reachableChannels(cfg, contact).length ? "found" : "not_found";
    await this.saveProspect(p);
    await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actionId: action.id, actor: AGENT_ACTOR, event: "contact.lookup", detail: { status: p.contactStatus, source: found.source } });
    return { status: p.contactStatus };
  }

  private async runScoring(action: Action, cfg: CampaignConfig) {
    const p = await this.requireProspect(action);
    const result = scoreProspect(cfg, await this.context(cfg, p));
    const previous = p.score;
    Object.assign(p, { score: result.score, scoreMax: result.max, tier: result.tier, persona: result.persona, scoreBreakdown: result.breakdown });
    const state = await this.state(p.campaignId);
    if (result.fit && !result.excluded && result.score >= (state.minScoreOverride ?? cfg.outreach.minScore)) {
      reachMilestone(p, cfg, "fit", this.clock.now().toISOString());
    }
    await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actionId: action.id, actor: AGENT_ACTOR, event: "score.changed", detail: { from: previous ?? null, to: result.score, max: result.max, tier: result.tier, signals: result.breakdown.map((b) => b.key) } });
    if (!result.fit || result.excluded) {
      p.status = "lost";
      p.attributes.lostReason = result.excluded ? "icp_exclusion" : "icp_no_fit";
      reachMilestone(p, cfg, "lost", this.clock.now().toISOString());
    }
    await this.saveProspect(p);
    return { ...result };
  }

  private async runQualification(action: Action, cfg: CampaignConfig) {
    const p = await this.requireProspect(action);
    const result = qualify(cfg, await this.context(cfg, p));
    const now = this.clock.now().toISOString();
    const was = p.qualification?.qualified;
    p.qualification = { ...result, at: now };
    if (was !== result.qualified) {
      await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actionId: action.id, actor: AGENT_ACTOR, event: "qualification.changed", detail: { qualified: result.qualified, met: result.met, missing: result.missing } });
    }
    if (result.qualified) reachMilestone(p, cfg, "qualified", now);
    await this.saveProspect(p);
    return result;
  }

  /** Sends sequence touches, conversational responses and conversion steps. */
  private async deliver(action: Action, cfg: CampaignConfig) {
    const p = await this.requireProspect(action);
    const channel = String(action.payload.channel);
    const sender = this.adapters.channels[channel];
    if (!sender) throw new Error(`no channel sender registered for '${channel}'`);
    const { externalId } = await sender.send({
      channel, to: String(action.payload.to), subject: action.payload.subject as string | undefined,
      body: String(action.payload.body), prospectId: p.id, campaignId: p.campaignId,
    });
    const now = this.clock.now().toISOString();
    const kind = action.payload.kind as Message["kind"];
    await this.store.messages.put({
      id: newId("msg"), clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, direction: "outbound",
      channel, kind, stepKey: action.payload.stepKey as string | undefined,
      templateKey: action.payload.templateKey as string | undefined, variantKey: action.payload.variantKey as string | undefined,
      subject: action.payload.subject as string | undefined, body: String(action.payload.body), externalId, at: now,
    });
    p.touches += 1;
    p.lastTouchAt = now;
    if (kind === "sequence") p.sequence.nextStepIndex += 1;
    if (kind === "conversion") {
      p.attributes.conversionStepAt = now;
      p.sequence.stopped = true;
    }
    reachMilestone(p, cfg, "contacted", now);
    await this.saveProspect(p);
    return { externalId };
  }

  // -------------------------------------------------------------------------
  // Replies & conversations
  // -------------------------------------------------------------------------

  /** Ingest an inbound message (from a channel webhook/poller); processing happens in the background. */
  async receiveReply(input: { campaignId: string; prospectId?: string; channel: string; from?: string; text: string; externalId?: string }) {
    const cfg = this.campaign(input.campaignId);
    const prospect = input.prospectId
      ? await this.store.prospects.get(input.prospectId)
      : await this.findProspectByHandle(cfg, input.from);
    if (!prospect || prospect.campaignId !== input.campaignId) throw new Error("reply does not match a prospect in this campaign");
    const msg: Message = {
      id: newId("msg"), clientId: prospect.clientId, campaignId: prospect.campaignId, prospectId: prospect.id,
      direction: "inbound", channel: input.channel, kind: "reply", body: input.text, externalId: input.externalId,
      at: this.clock.now().toISOString(),
    };
    await this.store.messages.put(msg);
    await this.queue.enqueue("reply.process", { messageId: msg.id });
    return msg;
  }

  private async processReply(messageId: string) {
    const msg = await this.store.messages.get(messageId);
    if (!msg || msg.intent) return;
    const cfg = this.campaign(msg.campaignId);
    const p = (await this.store.prospects.get(msg.prospectId))!;
    const contact = (await this.store.contacts.get(p.contactId))!;
    const now = this.clock.now().toISOString();

    const cls = await this.adapters.classifier.classify({ campaign: cfg, prospect: p, text: msg.body });
    const intent = cfg.replies.intents.find((i) => i.key === cls.intent) ?? cfg.replies.intents.find((i) => i.key === cfg.replies.defaultIntent)!;
    msg.intent = intent.key;
    msg.intentConfidence = cls.confidence;
    await this.store.messages.put(msg);

    p.lastIntent = intent.key;
    Object.assign(p.attributes, cls.extracted ?? {});
    reachMilestone(p, cfg, "replied", now);
    if (intent.sentiment === "positive") reachMilestone(p, cfg, "engaged", now);
    if (intent.milestone) reachMilestone(p, cfg, intent.milestone, now);
    if (intent.milestone === "lost") p.status = "lost";
    if (intent.stopSequence) p.sequence.stopped = true;
    if (intent.suppress) {
      p.status = "lost";
      contact.suppressed = true;
      await this.store.contacts.put(contact);
    }
    if (p.status === "exhausted" || p.status === "parked") p.status = "active";
    await this.saveProspect(p);
    await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR, event: "reply.classified", detail: { intent: intent.key, confidence: cls.confidence } });

    // Escalation: low classifier confidence or a configured rule → pause and surface to a human.
    const ctx = await this.context(cfg, p, { reply: { intent: intent.key, sentiment: intent.sentiment, confidence: cls.confidence, text: msg.body } });
    const reasons: { reason: string; severity: "low" | "medium" | "high"; pause: boolean; kind: "low_confidence" | "escalation" }[] = [];
    if (cls.confidence < cfg.replies.minClassificationConfidence) {
      reasons.push({ reason: `reply intent unclear (${intent.key} @ ${cls.confidence.toFixed(2)})`, severity: "medium", pause: true, kind: "low_confidence" });
    }
    for (const rule of cfg.escalation.rules) {
      if (evaluate(rule.when, ctx)) reasons.push({ reason: rule.reason, severity: rule.severity, pause: rule.pauseProspect, kind: "escalation" });
    }
    for (const r of reasons) {
      await this.gateway.raiseException({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, kind: r.kind, severity: r.severity, reason: r.reason });
    }
    const setNext = async (next: NonNullable<Message["nextAction"]>) => {
      msg.nextAction = next;
      await this.store.messages.put(msg);
    };
    if (reasons.some((r) => r.pause) && p.status === "active") {
      p.status = "paused";
      await this.saveProspect(p);
      await setNext({ kind: "escalate", summary: reasons.map((r) => r.reason).join("; ") });
      return;
    }
    if (p.status !== "active") {
      await setNext({ kind: "stop", summary: intent.suppress ? "contact opted out and is suppressed" : "prospect closed" });
      return;
    }
    await setNext(
      reasons.length
        ? { kind: "escalate", summary: reasons.map((r) => r.reason).join("; ") }
        : { kind: "wait", summary: intent.stopSequence ? "sequence stopped; re-qualifying" : "re-qualifying" },
    );

    await this.gateway.propose({
      clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR, type: "qualify",
      idempotencyKey: `qualify:${p.id}:${msg.id}`, confidence: cls.confidence, rationale: `re-qualify after '${intent.key}' reply`,
    });
    if (intent.respondWith) {
      const composed = await this.compose(cfg, p, intent.respondWith, msg.channel, { reply: { text: msg.body, intent: intent.key } });
      const response = await this.gateway.propose({
        clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: AGENT_ACTOR, type: "respond",
        idempotencyKey: `respond:${msg.id}`, payload: { ...composed.payload, kind: "response", inReplyTo: msg.id },
        confidence: Math.min(composed.confidence, cls.confidence), rationale: `routine reply to '${intent.key}'`,
      });
      if (msg.nextAction?.kind !== "escalate") await setNext({ kind: "respond", summary: `answer with ${intent.respondWith}`, actionId: response.id });
    }
  }

  // -------------------------------------------------------------------------
  // Outcomes & attribution
  // -------------------------------------------------------------------------

  /**
   * Record an external business event (payment succeeded, call booked,
   * form submitted...). If it satisfies the campaign's outcome
   * definition, an outcome is credited with attribution.
   */
  async recordEvent(input: {
    campaignId: string;
    type: string;
    payload?: Attributes;
    prospectId?: string;
    handle?: string;
  }): Promise<{ event: EventRecord; outcome?: OutcomeRecord }> {
    const cfg = this.campaign(input.campaignId);
    const now = this.clock.now().toISOString();
    const p = input.prospectId ? await this.store.prospects.get(input.prospectId) : await this.findProspectByHandle(cfg, input.handle);
    const event: EventRecord = {
      id: newId("evt"), clientId: cfg.client.id, campaignId: cfg.campaign.id, prospectId: p?.id,
      type: input.type, payload: input.payload ?? {}, at: now,
    };
    await this.store.events.put(event);
    await this.audit.record({ clientId: event.clientId, campaignId: event.campaignId, prospectId: p?.id, actor: SYSTEM_ACTOR, event: "event.recorded", detail: { type: event.type } });

    const ctx = p ? await this.context(cfg, p, { event }) : { event };
    if (p) await this.applyEventToJourney(cfg, p, event, ctx);
    if (!evaluate(cfg.outcome.achievedWhen, ctx)) return { event };
    if (p && (await this.store.outcomes.findOne((o) => o.prospectId === p.id && o.campaignId === cfg.campaign.id && o.counted))) {
      return { event };
    }

    const counted = !cfg.outcome.requiresQualification || Boolean(p?.qualification?.qualified);
    const touches = p
      ? (await this.store.messages.find((m) => m.prospectId === p.id && m.direction === "outbound")).sort((a, b) => a.at.localeCompare(b.at))
      : [];
    const ref = (m?: Message): TouchRef | undefined =>
      m && { channel: m.channel, stepKey: m.stepKey, templateKey: m.templateKey, variantKey: m.variantKey, at: m.at };
    const v = cfg.outcome.value;
    const amount = v?.fromField ? Number(getPath(ctx, v.fromField) ?? v.amount) : v?.amount;
    const outcome: OutcomeRecord = {
      id: newId("out"), clientId: cfg.client.id, campaignId: cfg.campaign.id, prospectId: p?.id,
      outcomeKey: cfg.outcome.key, counted,
      value: v && amount !== undefined ? { amount, currency: v.currency, recurrence: v.recurrence } : undefined,
      attribution: {
        firstTouch: ref(touches[0]),
        lastTouch: ref(touches.at(-1)),
        sourceTouch: ref(touches.filter((m) => m.kind === "sequence").at(-1)),
        touches: touches.length,
        persona: p?.persona,
        tier: p?.tier,
      },
      event, at: now,
    };
    await this.store.outcomes.put(outcome);
    await this.audit.record({ clientId: outcome.clientId, campaignId: outcome.campaignId, prospectId: p?.id, actor: SYSTEM_ACTOR, event: "outcome.achieved", detail: { outcome: outcome.outcomeKey, counted, value: outcome.value } });

    if (p) {
      if (counted) {
        p.status = "converted";
        p.sequence.stopped = true;
        reachMilestone(p, cfg, "outcome", now);
      }
      await this.saveProspect(p);
    }
    if (!counted) {
      await this.gateway.raiseException({
        clientId: cfg.client.id, campaignId: cfg.campaign.id, prospectId: p?.id, kind: "unqualified_outcome", severity: "low",
        reason: `${cfg.outcome.label} recorded for a prospect that is not qualified — not counted toward target`,
      });
    }
    return { event, outcome };
  }

  /** Appointment lifecycle and event-driven funnel stages (bookings, trials, viewings...). */
  private async applyEventToJourney(cfg: CampaignConfig, p: Prospect, event: EventRecord, ctx: Attributes) {
    const now = event.at;
    const appt = cfg.appointments;
    if (appt?.enabled) {
      const statusFor: Record<string, Appointment["status"]> = { [appt.events.booked]: "scheduled", [appt.events.held]: "held" };
      if (appt.events.cancelled) statusFor[appt.events.cancelled] = "cancelled";
      if (appt.events.noShow) statusFor[appt.events.noShow] = "no_show";
      const status = statusFor[event.type];
      if (status) {
        const existing = (await this.store.appointments.find((a) => a.prospectId === p.id && a.campaignId === cfg.campaign.id))
          .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))[0];
        const startsAt = getPath(ctx, appt.startsAtField);
        const messages = await this.store.messages.find((m) => m.prospectId === p.id);
        const reuse = existing && (existing.status === "scheduled" || status !== "scheduled");
        const record: Appointment = reuse
          ? { ...existing, status, updatedAt: now, startsAt: typeof startsAt === "string" ? startsAt : existing.startsAt, brief: buildBrief(cfg, p, messages) }
          : {
              id: newId("apt"), clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, status,
              startsAt: typeof startsAt === "string" ? startsAt : undefined, bookedAt: now, updatedAt: now,
              qualifiedAtBooking: Boolean(p.qualification?.qualified), brief: buildBrief(cfg, p, messages),
            };
        await this.store.appointments.put(record);
        await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: SYSTEM_ACTOR, event: `appointment.${status}`, detail: { appointmentId: record.id, startsAt: record.startsAt } });
      }
    }
    const stages = cfg.funnel.stages;
    const current = stages.findIndex((st) => st.key === p.stage);
    const target = stages.reduce((best, st, i) => (st.onEvent && evaluate(st.onEvent, ctx) && i > best ? i : best), -1);
    if (target > current && p.status !== "lost") {
      const from = p.stage;
      p.stage = stages[target]!.key;
      await this.saveProspect(p);
      await this.audit.record({ clientId: p.clientId, campaignId: p.campaignId, prospectId: p.id, actor: SYSTEM_ACTOR, event: "stage.changed", detail: { from, to: p.stage, event: event.type } });
    }
  }

  // -------------------------------------------------------------------------
  // Learning & optimization
  // -------------------------------------------------------------------------

  /** Learned stats; `includeInFlight` counts queued touches as allocations (for selection, not evaluation). */
  private async stats(cfg: CampaignConfig, includeInFlight = true) {
    const id = cfg.campaign.id;
    const [messages, outcomes, prospects, inFlight] = await Promise.all([
      this.store.messages.find((m) => m.campaignId === id),
      this.store.outcomes.find((o) => o.campaignId === id),
      this.store.prospects.find((p) => p.campaignId === id),
      this.store.actions.find((a) => a.campaignId === id && TOUCH_ACTIONS.includes(a.type) && IN_FLIGHT.has(a.status)),
    ]);
    return computeStats({ cfg, messages, outcomes, prospects, inFlight: includeInFlight ? inFlight.map((a) => a.payload) : [] });
  }

  async optimize(cfg: CampaignConfig): Promise<Recommendation[]> {
    const state = await this.state(cfg.campaign.id);
    state.lastOptimizedAt = this.clock.now().toISOString();
    await this.store.campaignState.put(state);
    const proposals = proposeOptimizations(cfg, state, await this.stats(cfg, false));
    const created: Recommendation[] = [];
    for (const prop of proposals) {
      const changeKey = JSON.stringify(prop.change);
      const dupe = await this.store.recommendations.findOne((r) => r.campaignId === cfg.campaign.id && JSON.stringify(r.change) === changeKey && r.status !== "dismissed");
      if (dupe) continue;
      await this.supersedeRecommendations(cfg.campaign.id, prop.change);
      const rec: Recommendation = { id: newId("rec"), clientId: cfg.client.id, campaignId: cfg.campaign.id, ...prop, status: "open", at: state.lastOptimizedAt };
      await this.store.recommendations.put(rec);
      created.push(rec);
      await this.gateway.propose({
        clientId: cfg.client.id, campaignId: cfg.campaign.id, actor: AGENT_ACTOR, type: "optimize",
        idempotencyKey: `optimize:${rec.id}`, payload: { recommendationId: rec.id }, confidence: 0.8, rationale: rec.summary,
      });
    }
    return created;
  }

  /** Newer evidence about the same lever replaces any open recommendation for it. */
  private async supersedeRecommendations(campaignId: string, change: NonNullable<Recommendation["change"]>) {
    const sameLever = (r: Recommendation) =>
      r.change?.op === change.op &&
      (change.op !== "disable_variant" || (r.change.op === "disable_variant" && r.change.templateKey === change.templateKey));
    const open = await this.store.recommendations.find((r) => r.campaignId === campaignId && r.status === "open" && sameLever(r));
    for (const rec of open) {
      rec.status = "dismissed";
      await this.store.recommendations.put(rec);
      const pendingAction = await this.store.actions.findOne((a) => a.campaignId === campaignId && a.idempotencyKey === `optimize:${rec.id}`);
      if (pendingAction) await this.gateway.cancel(pendingAction.id, "superseded by a newer recommendation");
    }
  }

  private async applyOptimization(action: Action) {
    const rec = await this.store.recommendations.get(String(action.payload.recommendationId));
    if (!rec?.change) throw new Error("recommendation not found or not applicable");
    const state = await this.state(rec.campaignId);
    if (rec.change.op === "disable_variant") state.disabledVariants.push(`${rec.change.templateKey}:${rec.change.variantKey}`);
    if (rec.change.op === "raise_min_score") state.minScoreOverride = rec.change.value;
    await this.store.campaignState.put(state);
    rec.status = "applied";
    await this.store.recommendations.put(rec);
    return { applied: rec.change };
  }

  // -------------------------------------------------------------------------
  // Human-in-the-loop controls
  // -------------------------------------------------------------------------

  approve(actionId: string, user: Actor, edits?: Attributes) {
    return this.gateway.approve(actionId, user, edits);
  }

  reject(actionId: string, user: Actor, reason: string) {
    return this.gateway.reject(actionId, user, reason);
  }

  async resolveException(exceptionId: string, user: Actor, opts: { resumeProspect?: boolean } = {}) {
    const exc = await this.store.exceptions.get(exceptionId);
    if (!exc) throw new Error("exception not found");
    if (user.type !== "user" || user.clientId !== exc.clientId || !user.roles?.some((r) => ["approver", "admin"].includes(r))) {
      throw new Error("user is not permitted to resolve this exception");
    }
    exc.status = "resolved";
    exc.resolvedAt = this.clock.now().toISOString();
    await this.store.exceptions.put(exc);
    await this.audit.record({ clientId: exc.clientId, campaignId: exc.campaignId, prospectId: exc.prospectId, actor: user, event: "exception.resolved", detail: { resume: Boolean(opts.resumeProspect) } });
    if (opts.resumeProspect && exc.prospectId) {
      const p = await this.store.prospects.get(exc.prospectId);
      if (p && p.status === "paused") {
        p.status = "active";
        await this.saveProspect(p);
        await this.queue.enqueue("prospect.advance", { prospectId: p.id });
      }
    }
  }

  async setCampaignStatus(campaignId: string, status: CampaignConfig["campaign"]["status"], actor: Actor) {
    const cfg = this.campaign(campaignId);
    cfg.campaign.status = status;
    await this.audit.record({ clientId: cfg.client.id, campaignId, actor, event: "campaign.status_changed", detail: { status } });
    if (status === "active") await this.scheduleTick(cfg, this.clock.now());
  }

  /**
   * Change how autonomously a campaign runs. Only client admins may do this;
   * every change is audited. This is the switch between human approval,
   * assisted automation and autonomous execution — no code changes involved.
   */
  async setAutonomy(
    campaignId: string,
    change: { level?: AutonomyLevel; actions?: CampaignConfig["autonomy"]["actions"] },
    user: Actor,
  ) {
    const cfg = this.campaign(campaignId);
    if (user.type !== "user" || user.clientId !== cfg.client.id || !user.roles?.includes("admin")) {
      await this.audit.record({ clientId: cfg.client.id, campaignId, actor: user, event: "automation.change_denied", detail: change });
      throw new Error("only a client admin can change automation");
    }
    const before = { level: cfg.autonomy.level, actions: structuredClone(cfg.autonomy.actions) };
    if (change.level) cfg.autonomy.level = change.level;
    if (change.actions) cfg.autonomy.actions = { ...cfg.autonomy.actions, ...change.actions };
    await this.audit.record({ clientId: cfg.client.id, campaignId, actor: user, event: "automation.changed", detail: { before, after: { level: cfg.autonomy.level, actions: cfg.autonomy.actions } } });
  }

  report(campaignId: string) {
    return buildClientReport({ cfg: this.campaign(campaignId), store: this.store, now: this.clock.now() });
  }

  analytics(campaignId: string) {
    return buildAnalytics({ cfg: this.campaign(campaignId), store: this.store });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async afterAction(action: Action) {
    if (action.prospectId) await this.queue.enqueue("prospect.advance", { prospectId: action.prospectId });
  }

  private async afterActionClosed(action: Action) {
    if (!action.prospectId) return;
    const p = await this.store.prospects.get(action.prospectId);
    if (!p) return;
    const type: ActionType = action.type;
    if (TOUCH_ACTIONS.includes(type) && action.status !== "failed") {
      // A rejected or blocked touch is skipped so the sequence keeps moving.
      const stepIdx = this.campaign(p.campaignId).outreach.sequence.findIndex((s) => s.key === action.payload.stepKey);
      if (stepIdx === p.sequence.nextStepIndex) {
        p.sequence.nextStepIndex += 1;
        await this.saveProspect(p);
      }
      await this.queue.enqueue("prospect.advance", { prospectId: p.id });
    }
    if (action.status === "failed" && ACTIVE_STATUSES.has(p.status)) {
      p.status = "paused"; // exception already raised by the gateway
      await this.saveProspect(p);
    }
  }

  private async requireProspect(action: Action): Promise<Prospect> {
    const p = action.prospectId ? await this.store.prospects.get(action.prospectId) : undefined;
    if (!p || p.clientId !== action.clientId) throw new Error("prospect not found for action");
    return p;
  }

  private async context(cfg: CampaignConfig, p: Prospect, extra?: Attributes) {
    const contact = (await this.store.contacts.get(p.contactId)) as Contact;
    const account = p.accountId ? await this.store.accounts.get(p.accountId) : undefined;
    return buildContext({ cfg, prospect: p, contact, account, extra });
  }

  private async findProspectByHandle(cfg: CampaignConfig, handle?: string) {
    if (!handle) return undefined;
    const h = handle.toLowerCase();
    const contact = await this.store.contacts.findOne(
      (c) => c.clientId === cfg.client.id && Object.values(c.handles).some((v) => v.toLowerCase() === h),
    );
    return contact && this.store.prospects.findOne((p) => p.contactId === contact.id && p.campaignId === cfg.campaign.id);
  }

  private async saveProspect(p: Prospect) {
    p.updatedAt = this.clock.now().toISOString();
    await this.store.prospects.put(p);
  }
}
