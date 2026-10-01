import {
  ACTION_TYPES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MODES,
  type ActionMode,
  type ActionType,
} from "../config/actions.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Action, Actor, Attributes, ExceptionItem } from "../domain/types.js";
import { TransientError, type Clock } from "../adapters/ports.js";
import type { Store } from "../store/store.js";
import type { JobQueue } from "../runtime/queue.js";
import { newId } from "../runtime/ids.js";
import { AuditLog, SYSTEM_ACTOR } from "./audit.js";
import { checkPolicies } from "./policies.js";
import { checkRateLimit } from "./rate-limiter.js";

export type ActionHandler = (action: Action, cfg: CampaignConfig) => Promise<Attributes | void>;

export interface GatewayHooks {
  onSucceeded?(action: Action): Promise<void>;
  onClosed?(action: Action): Promise<void>; // rejected / blocked / failed
}

export interface ProposeInput {
  clientId: string;
  campaignId: string;
  prospectId?: string;
  type: ActionType;
  idempotencyKey: string;
  payload?: Attributes;
  confidence: number;
  rationale: string;
  actor: Actor;
}

const APPROVER_ROLES = ["approver", "admin"];
const REOPENABLE = new Set(["failed", "cancelled"]);

export function resolveMode(cfg: CampaignConfig, type: ActionType): { mode: ActionMode; minConfidence: number } {
  const level = cfg.autonomy.level;
  const override = cfg.autonomy.actions[type] ?? {};
  return {
    mode: override.mode ?? DEFAULT_MODES[level][ACTION_TYPES[type].risk],
    minConfidence: override.minConfidence ?? DEFAULT_MIN_CONFIDENCE[level],
  };
}

/**
 * The single choke point every agent action passes through:
 *
 *   propose → idempotency → permission → policy/constraints → autonomy mode
 *           → confidence threshold → (approval | schedule) → rate limit
 *           → execute with retry → audit → escalate on failure
 *
 * Moving a campaign from human approval to assisted to fully autonomous only
 * changes the config that `resolveMode` reads — nothing here changes.
 */
export class ActionGateway {
  private readonly handlers = new Map<ActionType, ActionHandler>();

  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      queue: JobQueue;
      audit: AuditLog;
      campaign: (campaignId: string) => CampaignConfig;
      hooks?: GatewayHooks;
    },
  ) {
    deps.queue.register("action.execute", async (p) => this.execute(String(p.actionId)));
  }

  handle(type: ActionType, handler: ActionHandler) {
    this.handlers.set(type, handler);
  }

  async propose(input: ProposeInput): Promise<Action> {
    const { store, audit, clock } = this.deps;
    const cfg = this.deps.campaign(input.campaignId);
    const existing = await store.actions.findOne(
      (a) =>
        a.clientId === input.clientId &&
        a.campaignId === input.campaignId &&
        a.idempotencyKey === input.idempotencyKey &&
        !REOPENABLE.has(a.status),
    );
    if (existing) return existing;

    const now = clock.now().toISOString();
    const action: Action = {
      id: newId("act"),
      clientId: input.clientId,
      campaignId: input.campaignId,
      prospectId: input.prospectId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      confidence: input.confidence,
      rationale: input.rationale,
      proposedBy: input.actor,
      status: "proposed",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const base = { clientId: action.clientId, campaignId: action.campaignId, actionId: action.id, prospectId: action.prospectId };
    await audit.record({ ...base, actor: input.actor, event: "action.proposed", detail: { type: action.type, confidence: action.confidence, rationale: action.rationale } });

    // 1. Permission: is this actor allowed to take this action at all?
    if (input.actor.type === "agent" && !cfg.autonomy.allowedActions.includes(action.type)) {
      return this.close(action, "blocked", `agent not permitted to perform '${action.type}'`);
    }
    if (input.actor.clientId && input.actor.clientId !== action.clientId) {
      return this.close(action, "blocked", "actor belongs to a different client");
    }

    // 2. Policies & campaign constraints (blocking ones only; deferrals are re-checked at execution).
    const policy = await checkPolicies({ action, cfg, store, now: clock.now() });
    if (!policy.ok && policy.kind === "block") return this.close(action, "blocked", policy.reason);

    // 3. Autonomy mode + confidence threshold.
    const { mode, minConfidence } = resolveMode(cfg, action.type);
    action.mode = mode;
    if (mode === "disabled") return this.close(action, "blocked", `'${action.type}' is disabled for this campaign`);

    if (mode === "approval" || action.confidence < minConfidence) {
      const reason = mode === "approval" ? "approval required by autonomy policy" : `confidence ${action.confidence.toFixed(2)} below ${minConfidence}`;
      action.status = "pending_approval";
      await this.save(action);
      await audit.record({ ...base, actor: SYSTEM_ACTOR, event: "action.pending_approval", detail: { reason, mode } });
      return action;
    }

    action.status = "approved";
    action.decidedBy = SYSTEM_ACTOR;
    await this.save(action);
    await audit.record({ ...base, actor: SYSTEM_ACTOR, event: "action.auto_approved", detail: { mode, minConfidence } });
    await this.deps.queue.enqueue("action.execute", { actionId: action.id }, { dedupeKey: `exec:${action.id}:0` });
    return action;
  }

  async approve(actionId: string, user: Actor, edits?: Attributes): Promise<Action> {
    const action = await this.requireDecidable(actionId, user);
    if (edits) action.payload = { ...action.payload, ...edits, editedByHuman: true };
    action.status = "approved";
    action.decidedBy = user;
    await this.save(action);
    await this.deps.audit.record({ clientId: action.clientId, campaignId: action.campaignId, actionId, prospectId: action.prospectId, actor: user, event: "action.approved", detail: { edited: Boolean(edits) } });
    await this.deps.queue.enqueue("action.execute", { actionId }, { dedupeKey: `exec:${actionId}:0` });
    return action;
  }

  async reject(actionId: string, user: Actor, reason: string): Promise<Action> {
    const action = await this.requireDecidable(actionId, user);
    action.decidedBy = user;
    return this.close(action, "rejected", reason, user);
  }

  /** Withdraw an action that has not run yet (e.g. superseded by newer evidence). */
  async cancel(actionId: string, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<Action | undefined> {
    const action = await this.deps.store.actions.get(actionId);
    if (!action || !["proposed", "pending_approval", "approved", "scheduled"].includes(action.status)) return action;
    action.status = "cancelled";
    action.lastError = reason;
    await this.save(action);
    await this.deps.audit.record({ clientId: action.clientId, campaignId: action.campaignId, actionId, prospectId: action.prospectId, actor, event: "action.cancelled", detail: { reason } });
    return action;
  }

  /** Job handler: runs an approved/scheduled action with constraints, rate limits and retry. */
  async execute(actionId: string): Promise<void> {
    const { store, clock, audit, queue } = this.deps;
    const action = await store.actions.get(actionId);
    if (!action || !["approved", "scheduled"].includes(action.status)) return;
    const cfg = this.deps.campaign(action.campaignId);
    const base = { clientId: action.clientId, campaignId: action.campaignId, actionId, prospectId: action.prospectId };
    const now = clock.now();

    if (action.runAfter && new Date(action.runAfter) > now) {
      await queue.enqueue("action.execute", { actionId }, { runAt: new Date(action.runAfter) });
      return;
    }

    const policy = await checkPolicies({ action, cfg, store, now });
    if (!policy.ok) {
      if (policy.kind === "block") {
        await this.close(action, "blocked", policy.reason);
        return;
      }
      return this.defer(action, policy.until, policy.reason);
    }
    const rate = await checkRateLimit({ action, cfg, store, now });
    if (!rate.ok) return this.defer(action, rate.until, rate.reason);

    const handler = this.handlers.get(action.type);
    if (!handler) throw new Error(`no handler for action type '${action.type}'`);

    action.status = "executing";
    action.attempts += 1;
    action.executedAt = now.toISOString();
    await this.save(action);

    try {
      const result = await handler(action, cfg);
      action.status = "succeeded";
      action.result = result ?? {};
      action.runAfter = undefined;
      await this.save(action);
      await audit.record({ ...base, actor: SYSTEM_ACTOR, event: "action.succeeded", detail: { attempts: action.attempts, result: action.result } });
      await this.deps.hooks?.onSucceeded?.(action);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      action.lastError = message;
      action.executedAt = undefined; // failed attempts do not consume rate-limit budget
      const retry = cfg.constraints.retry;
      if (err instanceof TransientError && action.attempts < retry.maxAttempts) {
        const delay = retry.backoffSeconds * 1000 * retry.multiplier ** (action.attempts - 1);
        await audit.record({ ...base, actor: SYSTEM_ACTOR, event: "action.retry_scheduled", detail: { attempt: action.attempts, error: message, delayMs: delay } });
        return this.defer(action, new Date(now.getTime() + delay), `retry after transient error: ${message}`);
      }
      await this.close(action, "failed", message);
      await this.raiseException({
        clientId: action.clientId,
        campaignId: action.campaignId,
        prospectId: action.prospectId,
        actionId,
        kind: "action_failed",
        severity: ACTION_TYPES[action.type].risk === "external" ? "high" : "medium",
        reason: `${action.type} failed after ${action.attempts} attempt(s): ${message}`,
      });
    }
  }

  async raiseException(input: Omit<ExceptionItem, "id" | "status" | "at">): Promise<ExceptionItem> {
    const item: ExceptionItem = { ...input, id: newId("exc"), status: "open", at: this.deps.clock.now().toISOString() };
    await this.deps.store.exceptions.put(item);
    await this.deps.audit.record({ clientId: item.clientId, campaignId: item.campaignId, actionId: item.actionId, prospectId: item.prospectId, actor: SYSTEM_ACTOR, event: "exception.raised", detail: { kind: item.kind, severity: item.severity, reason: item.reason } });
    return item;
  }

  private async defer(action: Action, until: Date, reason: string) {
    action.status = "scheduled";
    action.runAfter = until.toISOString();
    await this.save(action);
    await this.deps.audit.record({ clientId: action.clientId, campaignId: action.campaignId, actionId: action.id, prospectId: action.prospectId, actor: SYSTEM_ACTOR, event: "action.deferred", detail: { reason, until: action.runAfter } });
    await this.deps.queue.enqueue("action.execute", { actionId: action.id }, { runAt: until });
  }

  private async close(action: Action, status: "blocked" | "rejected" | "failed", reason: string, actor: Actor = SYSTEM_ACTOR) {
    action.status = status;
    action.lastError = reason;
    await this.save(action);
    await this.deps.audit.record({ clientId: action.clientId, campaignId: action.campaignId, actionId: action.id, prospectId: action.prospectId, actor, event: `action.${status}`, detail: { reason } });
    await this.deps.hooks?.onClosed?.(action);
    return action;
  }

  private async requireDecidable(actionId: string, user: Actor): Promise<Action> {
    const action = await this.deps.store.actions.get(actionId);
    if (!action) throw new Error(`action ${actionId} not found`);
    if (user.type !== "user" || user.clientId !== action.clientId || !user.roles?.some((r) => APPROVER_ROLES.includes(r))) {
      await this.deps.audit.record({ clientId: action.clientId, campaignId: action.campaignId, actionId, actor: user, event: "action.decision_denied", detail: {} });
      throw new Error("user is not permitted to decide on this action");
    }
    if (action.status !== "pending_approval") throw new Error(`action is ${action.status}, not pending approval`);
    return action;
  }

  private async save(action: Action) {
    action.updatedAt = this.deps.clock.now().toISOString();
    await this.deps.store.actions.put(action);
  }
}
