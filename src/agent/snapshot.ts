import { ACTION_TYPES } from "../config/actions.js";
import type { CampaignConfig } from "../config/schema.js";
import { summarizeCampaign } from "../config/summary.js";
import type { AcquisitionEngine } from "../engine/engine.js";

const DAY = 86_400_000;

/**
 * Read-only snapshot of one campaign in the shape the client/operator UI
 * renders. Built from stored engine data — no model calls — and reused by the
 * demo-data script and the in-browser simulation.
 */
export async function snapshotCampaign(
  engine: AcquisitionEngine,
  cfg: CampaignConfig,
  opts: { start: Date; days: number; utcOffsetHours?: number },
) {
  const id = cfg.campaign.id;
  const clientId = cfg.client.id;
  const offset = (opts.utcOffsetHours ?? 3) * 3_600_000;
  const localDay = (iso: string | number) => new Date(new Date(iso).getTime() + offset).toISOString().slice(0, 10);

  const S = engine.store;
  const [prospects, contacts, accounts, messages, actions, outcomes, appts, recs, excs, audit] = await Promise.all([
    S.prospects.find((p) => p.campaignId === id), S.contacts.find((c) => c.clientId === clientId), S.accounts.find((a) => a.clientId === clientId),
    S.messages.find((m) => m.campaignId === id), S.actions.find((a) => a.campaignId === id), S.outcomes.find((o) => o.campaignId === id),
    S.appointments.find((a) => a.campaignId === id), S.recommendations.find((r) => r.campaignId === id), S.exceptions.find((e) => e.campaignId === id),
    S.audit.find((e) => e.campaignId === id),
  ]);
  const cById = new Map(contacts.map((c) => [c.id, c]));
  const aById = new Map(accounts.map((a) => [a.id, a]));
  const lastActivity = new Map<string, string>();
  for (const e of audit) if (e.prospectId && (lastActivity.get(e.prospectId) ?? "") < e.at) lastActivity.set(e.prospectId, e.at);

  const drafts: { prospectId: string; stepKey: string; dueAt: string; confidence: number; [k: string]: unknown }[] = [];
  for (const p of prospects) {
    const d = await engine.previewNextTouch(p.id);
    if (d) drafts.push(d);
  }

  const daily = [];
  for (let d = 0; d < opts.days; d++) {
    const day = localDay(opts.start.getTime() + d * DAY + 4 * 3_600_000);
    daily.push({
      day,
      outcomes: outcomes.filter((o) => o.counted && localDay(o.at) === day).length,
      sent: messages.filter((m) => m.direction === "outbound" && localDay(m.at) === day).length,
      replies: messages.filter((m) => m.direction === "inbound" && localDay(m.at) === day).length,
      discovered: prospects.filter((p) => localDay(p.createdAt) === day).length,
    });
  }

  return {
    clientId,
    config: summarizeCampaign(cfg),
    report: await engine.report(id),
    daily,
    analytics: await engine.analytics(id),
    prospects: prospects.map((p) => {
      const c = cById.get(p.contactId)!;
      const a = p.accountId ? aById.get(p.accountId) : undefined;
      const answers = p.research?.answers ?? {};
      return {
        id: p.id, company: a?.name, domain: a?.domain, city: a?.city ?? c.city, country: a?.country ?? c.country, employees: a?.employees,
        sector: (answers.sector as string) ?? (answers.agency_type as string) ?? (c.attributes.buyer_type as string) ?? a?.industry,
        contact: [c.firstName, c.lastName].filter(Boolean).join(" "), title: c.title, channels: Object.keys(c.handles), handleSource: c.externalIds.handleSource,
        persona: p.persona, score: p.score, scoreMax: p.scoreMax, tier: p.tier, breakdown: p.scoreBreakdown ?? [],
        researchStatus: p.researchStatus, signals: p.research?.signals ?? [], missing: p.research?.missing ?? [], rejected: p.research?.rejected ?? [], researchConfidence: p.research?.confidence,
        contactStatus: p.contactStatus, stage: p.stage, status: p.status, parkedReason: p.attributes.parkedReason, lostReason: p.attributes.lostReason,
        touches: p.touches, lastIntent: p.lastIntent, qualification: p.qualification, milestones: p.milestones,
        // Individuals have no company: show their own declared attributes instead.
        attrs: a ? undefined : Object.fromEntries(Object.entries(c.attributes).filter(([k]) => !k.startsWith("_"))),
        lastActivity: lastActivity.get(p.id) ?? p.updatedAt, createdAt: p.createdAt,
      };
    }),
    outreach: actions.filter((a) => ["send_message", "follow_up", "respond", "conversion_step"].includes(a.type)).map((a) => ({
      id: a.id, type: a.type, status: a.status, prospectId: a.prospectId, channel: a.payload.channel, subject: a.payload.subject, body: a.payload.body,
      step: a.payload.stepKey, template: a.payload.templateKey, variant: a.payload.variantKey, unresolved: a.payload.unresolved, confidence: a.confidence,
      rationale: a.rationale, createdAt: a.createdAt, executedAt: a.executedAt, runAfter: a.runAfter, decidedBy: a.decidedBy?.type, error: a.lastError, mode: a.mode,
    })),
    drafts: drafts.map((d) => ({ prospectId: d.prospectId, step: d.stepKey, dueAt: d.dueAt, channel: d.channel, subject: d.subject, body: d.body, confidence: d.confidence, variant: d.variantKey })),
    replies: messages.filter((m) => m.direction === "inbound").map((m) => ({ id: m.id, prospectId: m.prospectId, at: m.at, channel: m.channel, body: m.body, intent: m.intent, confidence: m.intentConfidence, nextAction: m.nextAction })),
    appointments: appts.map((a) => ({ id: a.id, prospectId: a.prospectId, status: a.status, startsAt: a.startsAt, bookedAt: a.bookedAt, qualifiedAtBooking: a.qualifiedAtBooking, brief: { ...a.brief, conversation: a.brief.conversation.slice(-4) } })),
    outcomes: outcomes.map((o) => ({ id: o.id, prospectId: o.prospectId, at: o.at, counted: o.counted, value: o.value?.amount, source: o.attribution.sourceTouch ?? o.attribution.lastTouch, touches: o.attribution.touches, persona: o.attribution.persona, tier: o.attribution.tier })),
    recommendations: recs.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, evidence: r.evidence, change: r.change, status: r.status, at: r.at, actionId: actions.find((a) => a.idempotencyKey === `optimize:${r.id}`)?.id })),
    exceptions: excs.map((e) => ({ id: e.id, kind: e.kind, severity: e.severity, reason: e.reason, prospectId: e.prospectId, status: e.status, at: e.at, resolvedAt: e.resolvedAt })),
    audit: audit.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 250).map((e) => ({ at: e.at, event: e.event, actor: e.actor.type, prospectId: e.prospectId, detail: e.detail })),
    auditCounts: audit.reduce<Record<string, number>>((m, e) => ((m[e.event] = (m[e.event] ?? 0) + 1), m), {}),
    governance: {
      auditTotal: audit.length,
      autoInternal: actions.filter((a) => a.decidedBy?.type === "system" && ACTION_TYPES[a.type].risk === "internal").length,
      humanApproved: actions.filter((a) => a.decidedBy?.type === "user" && a.status !== "rejected").length,
      rejected: actions.filter((a) => a.status === "rejected").length,
      blocked: actions.filter((a) => a.status === "blocked").length,
      deferred: audit.filter((e) => e.event === "action.deferred").length,
      retries: audit.filter((e) => e.event === "action.retry_scheduled").length,
    },
  };
}

export type CampaignSnapshot = Awaited<ReturnType<typeof snapshotCampaign>>;
