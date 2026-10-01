import { getPath } from "../config/evaluate.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Message, Prospect } from "../domain/types.js";
import type { Store } from "../store/store.js";
import { buildContext } from "../agents/context.js";

/**
 * Outcome-oriented breakdowns: for every comparison dimension, how prospects
 * move from contact to reply to outcome. Dimensions come from the campaign
 * config (geography, sector, persona...) plus the touch that opened the
 * conversation (channel, sequence step, message angle).
 */
export interface BreakdownRow {
  value: string;
  prospects: number;
  contacted: number;
  replied: number;
  positive: number;
  outcomes: number;
  /** outcomes / contacted */
  outcomeRate: number;
  /** positive replies / contacted */
  positiveRate: number;
}

export interface Breakdown {
  key: string;
  label: string;
  rows: BreakdownRow[];
}

export async function buildAnalytics(input: { cfg: CampaignConfig; store: Store }): Promise<Breakdown[]> {
  const { cfg, store } = input;
  const id = cfg.campaign.id;
  const [prospects, messages, outcomes] = await Promise.all([
    store.prospects.find((p) => p.campaignId === id),
    store.messages.find((m) => m.campaignId === id),
    store.outcomes.find((o) => o.campaignId === id && o.counted),
  ]);
  const positive = new Set(cfg.replies.intents.filter((i) => i.sentiment === "positive").map((i) => i.key));
  const byProspect = new Map<string, Message[]>();
  for (const m of messages) byProspect.set(m.prospectId, [...(byProspect.get(m.prospectId) ?? []), m]);
  const converted = new Set(outcomes.map((o) => o.prospectId));

  // The touch that opened the conversation (or the last touch if no reply yet).
  const openingTouch = (p: Prospect) => {
    const thread = (byProspect.get(p.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const firstReply = thread.find((m) => m.direction === "inbound");
    const touches = thread.filter((m) => m.direction === "outbound" && m.kind === "sequence" && (!firstReply || m.at <= firstReply.at));
    return touches.at(-1);
  };

  const rowsFor = async (valueOf: (p: Prospect) => Promise<string | undefined> | string | undefined) => {
    const rows = new Map<string, BreakdownRow>();
    for (const p of prospects) {
      const raw = await valueOf(p);
      if (raw === undefined || raw === "") continue;
      const row = rows.get(raw) ?? { value: raw, prospects: 0, contacted: 0, replied: 0, positive: 0, outcomes: 0, outcomeRate: 0, positiveRate: 0 };
      const inbound = (byProspect.get(p.id) ?? []).filter((m) => m.direction === "inbound");
      row.prospects++;
      if (p.milestones.contacted) row.contacted++;
      if (inbound.length) row.replied++;
      if (inbound.some((m) => m.intent && positive.has(m.intent))) row.positive++;
      if (converted.has(p.id)) row.outcomes++;
      rows.set(raw, row);
    }
    return [...rows.values()]
      .map((r) => ({ ...r, outcomeRate: r.contacted ? r.outcomes / r.contacted : 0, positiveRate: r.contacted ? r.positive / r.contacted : 0 }))
      .sort((a, b) => b.outcomes - a.outcomes || b.contacted - a.contacted);
  };

  const contexts = new Map<string, Record<string, unknown>>();
  const ctxOf = async (p: Prospect) => {
    let ctx = contexts.get(p.id);
    if (!ctx) {
      const contact = (await store.contacts.get(p.contactId))!;
      const account = p.accountId ? await store.accounts.get(p.accountId) : undefined;
      ctx = buildContext({ cfg, prospect: p, contact, account });
      contexts.set(p.id, ctx);
    }
    return ctx;
  };

  const out: Breakdown[] = [];
  for (const dim of cfg.analytics.dimensions) {
    out.push({
      key: dim.key,
      label: dim.label,
      rows: await rowsFor(async (p) => {
        const v = getPath(await ctxOf(p), dim.field);
        return v === undefined || v === null ? undefined : String(v);
      }),
    });
  }
  out.push({ key: "channel", label: "Channel", rows: await rowsFor((p) => openingTouch(p)?.channel) });
  out.push({ key: "step", label: "Sequence step", rows: await rowsFor((p) => openingTouch(p)?.stepKey) });
  out.push({
    key: "angle",
    label: "Message angle",
    rows: await rowsFor((p) => {
      const t = openingTouch(p);
      return t ? `${t.templateKey}:${t.variantKey}` : undefined;
    }),
  });
  return out;
}
