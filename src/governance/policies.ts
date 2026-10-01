import { ACTION_TYPES, TOUCH_ACTIONS } from "../config/actions.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Action, Contact, Prospect } from "../domain/types.js";
import type { Store } from "../store/store.js";

/**
 * Policy & constraint checks evaluated before an action is accepted and again
 * right before it executes (state may have changed in between, e.g. the
 * prospect replied or opted out).
 */
export type PolicyResult =
  | { ok: true }
  | { ok: false; kind: "block"; reason: string }
  | { ok: false; kind: "defer"; reason: string; until: Date };

const OK: PolicyResult = { ok: true };

export function localHour(date: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date);
  return Number(h) % 24;
}

export function inQuietHours(date: Date, cfg: CampaignConfig): boolean {
  const q = cfg.constraints.quietHours;
  if (!q || q.startHour === q.endHour) return false;
  const h = localHour(date, cfg.client.timezone);
  return q.startHour < q.endHour ? h >= q.startHour && h < q.endHour : h >= q.startHour || h < q.endHour;
}

/** Earliest time (15-minute granularity) outside quiet hours. */
export function nextAllowedTime(from: Date, cfg: CampaignConfig): Date {
  let t = new Date(from);
  for (let i = 0; i < 24 * 4 && inQuietHours(t, cfg); i++) t = new Date(t.getTime() + 15 * 60_000);
  return t;
}

function channelFor(action: Action) {
  return typeof action.payload.channel === "string" ? action.payload.channel : undefined;
}

export async function checkPolicies(input: {
  action: Action;
  cfg: CampaignConfig;
  store: Store;
  now: Date;
}): Promise<PolicyResult> {
  const { action, cfg, store, now } = input;

  if (cfg.campaign.status !== "active") {
    return { ok: false, kind: "block", reason: `campaign is ${cfg.campaign.status}` };
  }
  if (ACTION_TYPES[action.type].risk !== "external") return OK;

  const prospect = action.prospectId ? await store.prospects.get(action.prospectId) : undefined;
  if (!prospect) return { ok: false, kind: "block", reason: "external action without a prospect" };
  if (prospect.clientId !== action.clientId) return { ok: false, kind: "block", reason: "tenant mismatch" };
  const contact = await store.contacts.get(prospect.contactId);
  if (!contact) return { ok: false, kind: "block", reason: "contact not found" };

  const reach = checkReachability(action, cfg, contact);
  if (!reach.ok) return reach;

  if (prospect.status === "paused") return { ok: false, kind: "block", reason: "prospect paused pending human review" };
  const isTouch = TOUCH_ACTIONS.includes(action.type);
  if (["lost", "converted"].includes(prospect.status) && isTouch) {
    return { ok: false, kind: "block", reason: `prospect is ${prospect.status}` };
  }

  if (isTouch) {
    const seq = checkSequenceConstraints(prospect, cfg, now);
    if (!seq.ok) return seq;
  }

  if (inQuietHours(now, cfg)) {
    return { ok: false, kind: "defer", reason: "quiet hours", until: nextAllowedTime(now, cfg) };
  }
  return OK;
}

function checkReachability(action: Action, cfg: CampaignConfig, contact: Contact): PolicyResult {
  if (contact.suppressed) return { ok: false, kind: "block", reason: "contact is suppressed (opted out)" };
  const channelKey = channelFor(action);
  const channel = cfg.outreach.channels.find((c) => c.key === channelKey);
  if (!channel) return { ok: false, kind: "block", reason: `unknown channel '${channelKey}'` };
  const handle = contact.handles[channel.handle];
  if (!handle) return { ok: false, kind: "block", reason: `contact has no '${channel.handle}' handle` };
  if (channel.consentRequired && !contact.consents.includes(channel.key)) {
    return { ok: false, kind: "block", reason: `channel '${channel.key}' requires consent` };
  }
  const lowered = handle.toLowerCase();
  if (cfg.constraints.suppressedHandles.map((h) => h.toLowerCase()).includes(lowered)) {
    return { ok: false, kind: "block", reason: "handle on suppression list" };
  }
  const domain = lowered.includes("@") ? lowered.split("@")[1] : undefined;
  if (domain && cfg.constraints.suppressedDomains.map((d) => d.toLowerCase()).includes(domain)) {
    return { ok: false, kind: "block", reason: `domain ${domain} is suppressed` };
  }
  return OK;
}

function checkSequenceConstraints(prospect: Prospect, cfg: CampaignConfig, now: Date): PolicyResult {
  if (prospect.sequence.stopped) return { ok: false, kind: "block", reason: "sequence stopped" };
  if (prospect.touches >= cfg.constraints.maxTouchesPerProspect) {
    return { ok: false, kind: "block", reason: "max touches per prospect reached" };
  }
  if (prospect.lastTouchAt) {
    const earliest = new Date(new Date(prospect.lastTouchAt).getTime() + cfg.constraints.minHoursBetweenTouches * 3_600_000);
    if (earliest > now) return { ok: false, kind: "defer", reason: "min spacing between touches", until: earliest };
  }
  return OK;
}
