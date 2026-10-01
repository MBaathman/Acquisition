// Demo data for the prototype UI: runs every campaign config on the real engine for
// September 2026 with fictional prospects and simulated behaviour. DEMO DATA ONLY.
import { writeFileSync } from "node:fs";
import {
  AcquisitionEngine, AttributeResearchProvider, FixtureContactFinder, KeywordReplyClassifier, ManualClock,
  OutboxSender, StaticProspectSource, loadCampaignFile, type CampaignConfig, type DiscoveredProspect,
  type InMemoryQueue, snapshotCampaign,
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

const START = new Date("2026-08-31T21:00:00Z"); // 00:00 1 Sep, Riyadh
const DAYS = 30;
const END = START.getTime() + DAYS * DAY;

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
  const snap = await snapshotCampaign(engine, cfg, { start: START, days: DAYS });
  campaigns.push(snap);
  const { report, prospects, appointments: appts, drafts } = snap;
  const pending = snap.outreach.filter((a) => a.status === "pending_approval").length;
  console.log(cfg.client.name, "/", cfg.campaign.name, report.outcome.achieved, "/", report.outcome.target, "prospects", prospects.length, "pending", pending, "appts", appts.length, "drafts", drafts.length);
}

const data = { generatedAt: new Date(END).toISOString(), asOf: "2026-09-30", demo: true, clients: Object.values(clients), campaigns };
writeFileSync(new URL("../prototype/dist/demo-data.json", import.meta.url), JSON.stringify(data));
console.log("bytes", JSON.stringify(data).length);
