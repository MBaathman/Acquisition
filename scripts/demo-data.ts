// Demo data for the prototype UI: runs every campaign config on the real engine for
// September 2026 with fictional prospects and simulated behaviour. DEMO DATA ONLY.
import { writeFileSync } from "node:fs";
import {
  ACTION_TYPES, AcquisitionEngine, AttributeResearchProvider, FixtureContactFinder, KeywordReplyClassifier, ManualClock,
  OutboxSender, StaticProspectSource, loadCampaignFile, resolveMode, type CampaignConfig, type DiscoveredProspect,
  type InMemoryQueue, type ActionType,
} from "../src/index.js";

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const chance = (p: number) => rnd() < p;

const FIRST = ["Sara", "Khalid", "Noura", "Faisal", "Reem", "Omar", "Lama", "Abdullah", "Hessa", "Turki", "Maha", "Yousef", "Dana", "Fahad", "Rana", "Saad", "Layla", "Hamad", "Aisha", "Majed", "Mariam", "Rashed", "Huda", "Salem"];
const LAST = ["Al Harbi", "Al Mansoori", "Al Qahtani", "Al Suwaidi", "Al Otaibi", "Al Falasi", "Al Shamsi", "Al Ghamdi", "Al Nuaimi", "Al Dosari", "Haddad", "Khoury"];
const src = (source: string, url?: string, confidence = 0.9) => ({ source, url, confidence });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// ---------------------------------------------------------------- fixtures
function uaeAgencies(n: number): DiscoveredProspect[] {
  const a = ["Falcon", "Dune", "Pearl", "Marina", "Oasis", "Souk", "Creek", "Jumeirah", "Palm", "Sahara", "Nomad", "Atlas", "Mirage", "Zenith", "Corniche", "Saffron"];
  const b = ["Media Lab", "Growth Co", "Performance", "Digital", "Ads Studio", "Clicks", "Paid Social", "Agency", "Marketing", "Collective"];
  return Array.from({ length: n }, (_, i) => {
    const name = `${pick(a)} ${pick(b)}`;
    const dom = `${slug(name)}${i}.demo`;
    const city = pick(["Dubai", "Dubai", "Dubai", "Abu Dhabi", "Sharjah"]);
    const type = pick(["performance", "performance", "performance", "full_service", "media", "creative"]);
    const clients = Math.floor(1 + rnd() * 25);
    const platforms = ["meta", "google", "tiktok", "snapchat"].filter((p) => chance(p === "meta" ? 0.85 : p === "google" ? 0.7 : 0.4));
    const attrs: Record<string, unknown> = { agency_type: type, client_count: clients, ad_platforms: platforms };
    const sources: Record<string, unknown> = {
      agency_type: src("Agency website — services page", `https://${dom}/services`),
      client_count: src("Agency website — case studies", `https://${dom}/work`, 0.85),
      ad_platforms: src("Meta Business Partners & Google Partners directories", undefined, 0.9),
    };
    if (chance(0.55)) { attrs.reporting_requirement = pick(["monthly client performance reports", "weekly client dashboards", "Reporting Analyst job post"]); sources.reporting_requirement = src(pick(["Job post — Reporting Analyst (LinkedIn)", "Agency website — 'Transparent reporting' section"]), `https://${dom}/careers`, 0.8); }
    if (chance(0.35)) { attrs.growth_signal = pick(["hiring 2 media buyers", "opened Abu Dhabi office", "won 3 new retail clients"]); sources.growth_signal = src("LinkedIn company page — recent posts", undefined, 0.75); }
    if (chance(0.12)) delete sources.client_count; // unsourced claim → engine discards it
    const fn = pick(FIRST); const ln = pick(LAST);
    const title = pick(["Founder", "Managing Director", "CEO", "Head of Performance", "Paid Media Lead", "Account Director", "Growth Lead"]);
    const handles: Record<string, string> = {};
    if (chance(0.78)) handles.email = `${slug(fn)}@${dom}`;
    if (chance(0.7)) handles.linkedin = `linkedin.com/in/${slug(fn + ln)}${i}`;
    const findable = !Object.keys(handles).length && chance(0.6) ? { handles: { email: `${slug(fn)}.${slug(ln)}@${dom}` }, source: "Agency website — team page" } : undefined;
    return {
      account: { name, domain: dom, industry: "marketing", country: "AE", city, employees: pick([4, 8, 12, 18, 25, 35, 48, 70, 120]), attributes: { ...attrs, _sources: sources } },
      contact: { firstName: fn, lastName: ln, title, country: "AE", city, handles, attributes: findable ? { _findable: findable } : {} },
    };
  });
}

function ksaEnterprises(n: number): DiscoveredProspect[] {
  const a = ["Nakheel", "Wadi", "Rawabi", "Sahm", "Manar", "Najd", "Tamkeen", "Masar", "Bayan", "Qimam", "Yusr", "Rukn", "Afaq", "Sanad", "Watan", "Thamar", "Jood", "Ameen"];
  const b = ["Retail", "Logistics", "Foods", "Holding", "Health", "Motors", "Industries", "Travel", "Construction", "Energy", "Group"];
  return Array.from({ length: n }, (_, i) => {
    const name = `${pick(a)} ${pick(b)}`; const dom = `${slug(name)}${i}.demo`;
    const city = pick(["Riyadh", "Riyadh", "Jeddah", "Dammam", "Khobar"]);
    const sector = pick(["retail", "logistics", "healthcare", "manufacturing", "hospitality", "construction"]);
    const attrs: Record<string, unknown> = { sector };
    const sources: Record<string, unknown> = { sector: src("Saudi Business Center — CR record", undefined, 0.95) };
    if (chance(0.45)) { attrs.recent_initiative = pick(["expanding to Jeddah", "launching a new distribution centre", "hiring 50+ operations staff", "rolling out a new ERP"]); sources.recent_initiative = src(pick(["Argaam — news", "Company press release", "LinkedIn company page"]), `https://${dom}/news`, 0.8); }
    const fn = pick(FIRST); const ln = pick(LAST);
    const handles: Record<string, string> = {};
    if (chance(0.8)) handles.email = `${slug(fn)}.${slug(ln)}@${dom}`;
    if (chance(0.65)) handles.linkedin = `linkedin.com/in/${slug(fn + ln)}${i}`;
    const findable = !Object.keys(handles).length && chance(0.5) ? { handles: { email: `${slug(fn)}@${dom}` }, source: "Company website — leadership page" } : undefined;
    return {
      account: { name, domain: dom, industry: sector, country: "SA", city, employees: pick([40, 80, 150, 250, 400, 900, 2500]), attributes: { ...attrs, _sources: sources } },
      contact: { firstName: fn, lastName: ln, title: pick(["CEO", "COO", "General Manager", "Managing Director", "Director of Operations", "Head of Strategy", "Finance Manager", "Operations Manager", "Analyst"]), country: "SA", city, handles, attributes: findable ? { _findable: findable } : {} },
    };
  });
}

function realEstateLeads(n: number): DiscoveredProspect[] {
  return Array.from({ length: n }, (_, i) => {
    const fn = pick(FIRST); const ln = pick(LAST);
    const city = pick(["Riyadh", "Riyadh", "Jeddah", "Dammam", "Khobar"]);
    const handles: Record<string, string> = { phone: `+9665${String(10000000 + Math.floor(rnd() * 89999999))}` };
    if (chance(0.6)) handles.email = `${slug(fn)}.${i}@mail.demo`;
    return {
      contact: {
        firstName: fn, lastName: ln, city, country: "SA", handles, consents: chance(0.7) ? ["whatsapp"] : [],
        attributes: {
          buyer_type: pick(["investor", "investor", "end_user", "business_owner"]),
          budget: pick([600000, 900000, 1500000, 2200000, 3500000]),
          timeline: pick(["0-3m", "3-6m", "6-12m", "12m+"]),
          target_area: chance(0.7) ? pick(["North Riyadh", "Jeddah Waterfront", "Al Khobar Corniche"]) : undefined,
          property_type: pick([["apartment"], ["villa"], ["office"]]),
        },
      },
    };
  });
}

// ---------------------------------------------------------------- behaviour
type Plan = { file: string; fixtures: DiscoveredProspect[]; patch?: (c: CampaignConfig) => void; simulate: boolean;
  replyPool: [number, string][]; conv: (pid: string, now: number) => { at: number; type: string; payload?: Record<string, unknown> }[] };

const DAY = 86400e3;
const plans: Plan[] = [
  {
    file: "campaigns/dataspeaks/uae-agency-acquisition.yaml", fixtures: uaeAgencies(380), simulate: true,
    patch: (c) => { c.campaign.budget = { amount: 1200, currency: "USD", period: "monthly" }; },
    replyPool: [[0.1, "Yes, interested — happy to try the trial"], [0.045, "How does pricing work for 15 client accounts?"], [0.05, "Not interested, thanks"], [0.03, "not now, maybe next quarter"], [0.01, "please unsubscribe me"], [0.012, "Interested, but we would need an enterprise contract and a discount"], [0.012, "ok"]],
    conv: (pid, now) => {
      const out = [];
      if (chance(0.72)) {
        const t = now + (0.5 + rnd() * 2) * DAY; out.push({ at: t, type: "trial.started" });
        if (chance(0.62)) out.push({ at: t + (3 + rnd() * 7) * DAY, type: "subscription.paid", payload: { amount: pick([99, 99, 149, 299]) } });
      }
      return out;
    },
  },
  { file: "campaigns/dataspeaks/ksa-agency-acquisition.yaml", fixtures: [], simulate: false, replyPool: [], conv: () => [] },
  {
    file: "campaigns/tatimmah/saudi-enterprise-outreach.yaml", fixtures: ksaEnterprises(420), simulate: true,
    patch: (c) => { c.campaign.budget = { amount: 9000, currency: "SAR", period: "monthly" }; },
    replyPool: [[0.06, "Interested — tell me more"], [0.045, "Could we schedule a call next week?"], [0.05, "Not interested, thanks"], [0.012, "Please contact my colleague Ahmed instead"], [0.01, "please unsubscribe me"], [0.012, "noted"]],
    conv: (pid, now) => {
      if (!chance(0.36)) return [];
      const booked = now + (0.5 + rnd() * 2.5) * DAY;
      const startsAt = booked + (2 + rnd() * 9) * DAY;
      const r = rnd();
      const ev = [{ at: booked, type: "meeting.booked", payload: { startsAt: new Date(Math.round(startsAt / 3600e3) * 3600e3).toISOString() } }];
      ev.push({ at: startsAt + 3600e3, type: r < 0.74 ? "meeting.held" : r < 0.87 ? "meeting.no_show" : "meeting.cancelled" } as never);
      return ev;
    },
  },
  {
    file: "campaigns/templates/real-estate-qualified-leads.yaml", fixtures: realEstateLeads(320), simulate: true,
    patch: (c) => { c.campaign.status = "active"; c.campaign.name = "Off-plan Investors (example)"; c.campaign.period = { start: "2026-09-01" }; },
    replyPool: [[0.09, "مهتم، أرسل التفاصيل والأسعار"], [0.05, "غير مهتم"], [0.01, "إلغاء الاشتراك stop"], [0.01, "تمام"]],
    conv: (pid, now) => {
      if (!chance(0.6)) return [];
      const b = now + (0.5 + rnd() * 2) * DAY; const s = b + (1 + rnd() * 5) * DAY;
      const ev = [{ at: b, type: "viewing.booked", payload: { startsAt: new Date(Math.round(s / 3600e3) * 3600e3).toISOString() } }, { at: s + 3600e3, type: "viewing.held" }];
      if (chance(0.7)) ev.push({ at: s + 1.2 * DAY, type: "lead.verified" } as never);
      return ev;
    },
  },
];

const fieldsOf = (rule: any): string[] => rule.field ? [rule.field] : rule.all ? rule.all.flatMap(fieldsOf) : rule.any ? rule.any.flatMap(fieldsOf) : rule.not ? fieldsOf(rule.not) : [];
const START = new Date("2026-08-31T21:00:00Z"); // 00:00 1 Sep, Riyadh
const DAYS = 30;
const END = START.getTime() + DAYS * DAY;
const riyadhDay = (iso: string | number) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 10);

const clients: Record<string, { id: string; name: string; industry?: string }> = {};
const campaigns: unknown[] = [];

for (const plan of plans) {
  const clock = new ManualClock(START);
  const outbox = new OutboxSender();
  const source = new StaticProspectSource(plan.fixtures);
  const engine = new AcquisitionEngine({
    clock, sources: { apollo: source, crm_import: source }, research: { default: new AttributeResearchProvider() },
    contactFinders: { demo_finder: new FixtureContactFinder() }, channels: { email: outbox, linkedin: outbox, whatsapp: outbox },
    classifier: new KeywordReplyClassifier(),
  });
  const q = engine.queue as InMemoryQueue;
  const cfg = await loadCampaignFile(plan.file);
  plan.patch?.(cfg);
  cfg.optimization.minSampleSize = 15;
  cfg.scheduling.tickMinutes = 180;
  cfg.discovery.batchSize = 6;
  const id = cfg.campaign.id; const clientId = cfg.client.id;
  clients[clientId] = { id: clientId, name: cfg.client.name, industry: cfg.client.industry };
  const reviewer = { type: "user" as const, id: "demo-reviewer", clientId, roles: ["approver", "admin"] };
  await engine.registerCampaign(cfg);

  const replies: { at: number; pid: string; text: string }[] = [];
  const events: { at: number; pid: string; type: string; payload?: Record<string, unknown> }[] = [];
  const seen = new Set<string>(); const seenConv = new Set<string>();
  if (plan.simulate) {
    for (let h = 0; h < DAYS * 24; h++) {
      const now = clock.now().getTime();
      const reviewing = h < DAYS * 24 - 22; // the last hours stay unreviewed → live approval queue
      await q.runDue();
      if (reviewing && h % 3 === 0) {
        for (const a of await engine.store.actions.find((a) => a.campaignId === id && a.status === "pending_approval")) {
          if (a.type === "optimize") continue;
          if (chance(0.04)) await engine.reject(a.id, reviewer, pick(["Tone not right for this contact", "Wrong person — try the founder", "Already in conversation via a partner"]));
          else await engine.approve(a.id, reviewer);
        }
      }
      if (h % 24 === 12 && h < 24 * 25) {
        for (const e of await engine.store.exceptions.find((e) => e.campaignId === id && e.status === "open" && now - new Date(e.at).getTime() > 4 * DAY)) {
          await engine.resolveException(e.id, reviewer, { resumeProspect: true });
        }
      }
      for (const r of replies.filter((r) => r.at <= now)) {
        replies.splice(replies.indexOf(r), 1);
        const p = await engine.store.prospects.get(r.pid);
        if (p && !["lost", "converted"].includes(p.status)) {
          const last = (await engine.store.messages.find((m) => m.prospectId === r.pid && m.direction === "outbound")).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
          await engine.receiveReply({ campaignId: id, prospectId: r.pid, channel: last?.channel ?? "email", text: r.text });
        }
      }
      for (const e of events.filter((e) => e.at <= now)) {
        events.splice(events.indexOf(e), 1);
        await engine.recordEvent({ campaignId: id, prospectId: e.pid, type: e.type, payload: e.payload });
      }
      await q.runDue();
      for (const m of await engine.store.messages.find((m) => m.campaignId === id && m.direction === "outbound")) {
        if (seen.has(m.id)) continue; seen.add(m.id);
        if (m.kind === "conversion" && !seenConv.has(m.prospectId)) {
          seenConv.add(m.prospectId);
          for (const e of plan.conv(m.prospectId, now)) events.push({ ...e, pid: m.prospectId });
        }
        if (m.kind !== "sequence") continue;
        let x = rnd(); const boost = ["pain_led", "initiative_led"].includes(m.variantKey ?? "") ? 1.4 : 1;
        for (const [p, text] of plan.replyPool) { if (x < p * boost) { replies.push({ at: now + (3 + rnd() * 50) * 3600e3, pid: m.prospectId, text }); break; } x -= p * boost; }
      }
      clock.advance(3600e3);
    }
  }

  // ------------------------------------------------------------ export
  const S = engine.store;
  const [prospects, contacts, accounts, messages, actions, outcomes, appts, recs, excs, audit] = await Promise.all([
    S.prospects.find((p) => p.campaignId === id), S.contacts.find((c) => c.clientId === clientId), S.accounts.find((a) => a.clientId === clientId),
    S.messages.find((m) => m.campaignId === id), S.actions.find((a) => a.campaignId === id), S.outcomes.find((o) => o.campaignId === id),
    S.appointments.find((a) => a.campaignId === id), S.recommendations.find((r) => r.campaignId === id), S.exceptions.find((e) => e.campaignId === id),
    S.audit.find((e) => e.campaignId === id),
  ]);
  const cById = new Map(contacts.map((c) => [c.id, c])); const aById = new Map(accounts.map((a) => [a.id, a]));
  const lastActivity = new Map<string, string>();
  for (const e of audit) if (e.prospectId && (lastActivity.get(e.prospectId) ?? "") < e.at) lastActivity.set(e.prospectId, e.at);

  const drafts = [];
  for (const p of prospects) { const d = await engine.previewNextTouch(p.id); if (d) drafts.push(d); }

  const report = plan.simulate || prospects.length ? await engine.report(id) : await engine.report(id);
  const daily = [];
  for (let d = 0; d < DAYS; d++) {
    const day = riyadhDay(START.getTime() + d * DAY + 4 * 3600e3);
    daily.push({
      day,
      outcomes: outcomes.filter((o) => o.counted && riyadhDay(o.at) === day).length,
      sent: messages.filter((m) => m.direction === "outbound" && riyadhDay(m.at) === day).length,
      replies: messages.filter((m) => m.direction === "inbound" && riyadhDay(m.at) === day).length,
      discovered: prospects.filter((p) => riyadhDay(p.createdAt) === day).length,
    });
  }
  const modes = Object.fromEntries((Object.keys(ACTION_TYPES) as ActionType[]).map((t) => [t, { ...resolveMode(cfg, t), risk: ACTION_TYPES[t].risk, allowed: cfg.autonomy.allowedActions.includes(t) }]));

  campaigns.push({
    clientId,
    config: {
      id, name: cfg.campaign.name, status: cfg.campaign.status, description: cfg.campaign.description, period: cfg.campaign.period, budget: cfg.campaign.budget,
      outcome: { key: cfg.outcome.key, label: cfg.outcome.label, unit: cfg.outcome.unit, target: cfg.outcome.target?.count, currency: cfg.outcome.value?.currency, requiresQualification: cfg.outcome.requiresQualification },
      icp: cfg.icp.description, personas: cfg.icp.personas.map((p) => ({ key: p.key, label: p.label })), market: cfg.market, offer: cfg.offer,
      scoring: { scale: cfg.scoring.scale, signals: cfg.scoring.signals.map((s) => ({ key: s.key, label: s.label, weight: s.weight, category: s.category, reads: fieldsOf(s.when) })), tiers: cfg.scoring.tiers, minScore: cfg.outreach.minScore, max: cfg.scoring.scale === "points" ? cfg.scoring.signals.reduce((a, s) => a + Math.max(0, s.weight), 0) : 100 },
      research: cfg.research.questions.map((q) => ({ key: q.key, prompt: q.prompt, required: q.required })), researchMinConfidence: cfg.research.minConfidence,
      qualification: cfg.qualification.criteria.map((c) => ({ key: c.key, label: c.label, required: c.required })),
      funnel: cfg.funnel.stages.map((s) => ({ key: s.key, label: s.label, milestone: s.milestone, onEvent: Boolean(s.onEvent) })),
      appointments: cfg.appointments ? { label: cfg.appointments.label, singular: cfg.appointments.singular } : null,
      channels: cfg.outreach.channels, sequence: cfg.outreach.sequence.map((s) => ({ key: s.key, channel: s.channel, dayOffset: s.dayOffset, template: s.template })),
      intents: cfg.replies.intents.map((i) => ({ key: i.key, label: i.label, sentiment: i.sentiment })), minClassificationConfidence: cfg.replies.minClassificationConfidence,
      autonomy: { level: cfg.autonomy.level, modes }, constraints: { quietHours: cfg.constraints.quietHours, maxTouches: cfg.constraints.maxTouchesPerProspect, minHoursBetweenTouches: cfg.constraints.minHoursBetweenTouches, rateLimits: cfg.constraints.rateLimits, retry: cfg.constraints.retry },
      escalation: cfg.escalation.rules.map((r) => ({ key: r.key, reason: r.reason, severity: r.severity })),
      integrations: { discovery: cfg.discovery.source, research: cfg.research.provider, contactFinder: cfg.contacts.finder, channels: cfg.outreach.channels.map((c) => c.key) },
      dimensions: cfg.analytics.dimensions,
      timezone: cfg.client.timezone,
    },
    report, daily, analytics: await engine.analytics(id),
    prospects: prospects.map((p) => {
      const c = cById.get(p.contactId)!; const a = p.accountId ? aById.get(p.accountId) : undefined;
      return {
        id: p.id, company: a?.name, domain: a?.domain, city: a?.city ?? c.city, country: a?.country ?? c.country, employees: a?.employees,
        sector: (p.research?.answers.sector as string) ?? (p.research?.answers.agency_type as string) ?? (c.attributes.buyer_type as string) ?? a?.industry,
        contact: [c.firstName, c.lastName].filter(Boolean).join(" "), title: c.title, channels: Object.keys(c.handles), handleSource: c.externalIds.handleSource,
        persona: p.persona, score: p.score, scoreMax: p.scoreMax, tier: p.tier, breakdown: p.scoreBreakdown ?? [],
        researchStatus: p.researchStatus, signals: p.research?.signals ?? [], missing: p.research?.missing ?? [], rejected: p.research?.rejected ?? [], researchConfidence: p.research?.confidence,
        contactStatus: p.contactStatus, stage: p.stage, status: p.status, parkedReason: p.attributes.parkedReason, lostReason: p.attributes.lostReason,
        touches: p.touches, lastIntent: p.lastIntent, qualification: p.qualification, milestones: p.milestones,
        attrs: plan.file.includes("real-estate") ? { budget: c.attributes.budget, timeline: c.attributes.timeline, target_area: c.attributes.target_area, buyer_type: c.attributes.buyer_type } : undefined,
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
      auditTotal: audit.length, autoInternal: actions.filter((a) => a.decidedBy?.type === "system" && ACTION_TYPES[a.type].risk === "internal").length,
      humanApproved: actions.filter((a) => a.decidedBy?.type === "user" && a.status !== "rejected").length, rejected: actions.filter((a) => a.status === "rejected").length,
      blocked: actions.filter((a) => a.status === "blocked").length, deferred: audit.filter((e) => e.event === "action.deferred").length, retries: audit.filter((e) => e.event === "action.retry_scheduled").length,
    },
  });
  console.log(cfg.client.name, "/", cfg.campaign.name, report.outcome.achieved, "/", report.outcome.target, "prospects", prospects.length, "pending", actions.filter((a) => a.status === "pending_approval").length, "appts", appts.length, "drafts", drafts.length);
}

const data = { generatedAt: new Date(END).toISOString(), asOf: "2026-09-30", demo: true, clients: Object.values(clients), campaigns };
writeFileSync(new URL("../prototype/dist/demo-data.json", import.meta.url), JSON.stringify(data));
console.log("bytes", JSON.stringify(data).length);
