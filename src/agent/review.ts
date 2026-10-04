import type { Locale } from "../config/builder.js";
import { normalize } from "./planner.js";
import type { CampaignSnapshot } from "./snapshot.js";

/**
 * The agent's review queue: one item per drafted message, with why the
 * prospect was picked (sourced reasons only), the agent's reservations, and
 * the message itself. The user approves, excludes or rewrites items — one at a
 * time or as a group, by button or by saying so in the chat.
 *
 * Messages are composed from structured parts (greeting, sourced hook, value,
 * call to action) with a style, so "shorter", "more direct", "in Arabic" or
 * "don't mention X" re-compose them deterministically. Facts without a source
 * are never written into a message.
 */

export type ReviewStatus = "ready" | "approved" | "needs_edit" | "excluded";

export interface MessageStyle {
  language: Locale;
  short: boolean;
  direct: boolean;
  avoid: string[];
  mention: string[];
}

export interface ReviewItem {
  /** The engine action id of the drafted message. */
  id: string;
  prospectId: string;
  company: string;
  person: string;
  firstName: string;
  firstNameAr?: string;
  title?: string;
  city?: string;
  employees?: number;
  score: number | null;
  max: number | null;
  /** Why the prospect fits — only signals backed by a source or firmographics. */
  reasons: { label: string; text?: Record<Locale, string>; source?: string; url?: string }[];
  /** Facts found without a source (discarded, never stated). */
  unverified: number;
  /** The agent's reservations; an item with any stays "needs_edit" until the user decides. */
  flags: string[];
  channel?: string;
  subject?: string;
  body: string;
  style: MessageStyle;
  status: ReviewStatus;
  edited: boolean;
  /** A rewrite of this one message, waiting for "accept edit". */
  pendingEdit?: { subject?: string; body: string; notes: string[]; style: MessageStyle };
  updatedAt: string;
}

export interface ReviewPolicy {
  /** manual = every message waits for a person; auto = clean messages at or above the score are approved automatically. */
  mode: "manual" | "auto";
  autoAbove?: number;
}

export interface OfferText {
  name: string;
  value: Record<Locale, string>;
  cta: Record<Locale, string>;
  link?: string;
}

export interface ReviewFilter {
  all?: boolean;
  ids?: string[];
  names?: string[];
  cities?: string[];
  minScore?: number;
  maxScore?: number;
  top?: number;
  large?: boolean;
  /** Items whose reasons do NOT include a signal matching this keyword (e.g. "client"). */
  lacksSignal?: string;
  status?: ReviewStatus[];
}

export interface RewriteInstruction {
  short?: boolean;
  direct?: boolean;
  language?: Locale;
  avoid?: string[];
  mention?: string[];
}

const L = (loc: Locale, ar: string, en: string) => (loc === "ar" ? ar : en);

// ---------------------------------------------------------------------------
// Composition

export function composeMessage(item: Pick<ReviewItem, "company" | "firstName" | "firstNameAr" | "reasons">, offer: OfferText, style: MessageStyle, noteLocale: Locale = style.language): { subject: string; body: string; notes: string[] } {
  const loc = style.language;
  const N = (ar: string, en: string) => L(noteLocale, ar, en);
  const notes: string[] = [];
  const has = (text: string, term: string) => normalize(text).replace(/^ال/, "").includes(normalize(term).replace(/^ال/, ""));
  const avoided = (text: string) => style.avoid.some((t) => has(text, t));
  const textOf = (r: ReviewItem["reasons"][number]) => r.text?.[loc] ?? r.label;
  let reasons = item.reasons.map(textOf).filter((l) => !avoided(l));
  const mentioned: string[] = [];
  for (const term of style.mention) {
    const hit = item.reasons.find((r) => has(r.label, term) || has(textOf(r), term) || (r.text && (has(r.text.ar, term) || has(r.text.en, term))));
    if (hit) mentioned.push(textOf(hit));
    else notes.push(N(`لم أجد مصدراً يؤكد «${term}» عند ${item.company}، فلم أذكره.`, `No source confirms “${term}” for ${item.company}, so I left it out.`));
  }
  reasons = [...new Set([...mentioned, ...reasons])].slice(0, style.short ? 1 : 2);
  // Mid-sentence in English: "serves 3+ clients", but keep names like "Meta".
  if (loc === "en") reasons = reasons.map((r) => (/^[A-Z][a-z]/.test(r) && !/^(Meta|Google|TikTok|LinkedIn|Snapchat)\b/.test(r) ? r[0]!.toLowerCase() + r.slice(1) : r));
  const name = loc === "ar" ? item.firstNameAr ?? item.firstName : item.firstName;
  const joined = reasons.join(L(loc, "، ", ", "));
  const value = avoided(offer.value[loc]) ? "" : offer.value[loc];
  const cta = `${offer.cta[loc]}${offer.link ? ` — ${offer.link}` : ""}`;
  const lines: string[] = [];
  if (style.direct) {
    lines.push(L(loc, `${name}،`, `${name},`));
    if (value) lines.push(reasons.length ? L(loc, `${value} وهذا يناسب ${item.company} لأن: ${joined}.`, `${value} It fits ${item.company} because: ${joined}.`) : value);
    else if (reasons.length) lines.push(L(loc, `${item.company}: ${joined}.`, `${item.company}: ${joined}.`));
  } else {
    lines.push(L(loc, `مرحباً ${name}،`, `Hi ${name},`));
    if (reasons.length) lines.push(L(loc, `اطلعت على ${item.company}: ${joined}.`, `I looked at ${item.company}: ${joined}.`));
    if (value && !style.short) lines.push(value);
  }
  lines.push(cta);
  const subject = L(loc, `${item.company} و${offer.name}`, `${item.company} × ${offer.name}`);
  if (style.avoid.length && item.reasons.some((r) => avoided(textOf(r)))) notes.push(N(`حذفت ذكر ${style.avoid.join("، ")}.`, `Removed mentions of ${style.avoid.join(", ")}.`));
  return { subject, body: lines.join("\n"), notes };
}

// ---------------------------------------------------------------------------
// Building the queue from the engine's drafted messages

type SnapProspect = CampaignSnapshot["prospects"][number];

export function buildReview(
  snapshot: Pick<CampaignSnapshot, "prospects" | "outreach">,
  offer: OfferText,
  language: Locale,
  opts: { now: string; policy?: ReviewPolicy; previous?: ReviewItem[]; reviewLocale: Locale; labels?: Record<string, Record<Locale, string>> },
): ReviewItem[] {
  const loc = opts.reviewLocale;
  const P = new Map<string, SnapProspect>(snapshot.prospects.map((p) => [p.id, p]));
  const prev = new Map((opts.previous ?? []).map((i) => [`${i.company}|${i.person}`, i]));
  const items: ReviewItem[] = [];
  for (const a of snapshot.outreach) {
    if (a.status !== "pending_approval" || !(a.type === "send_message" || a.type === "follow_up")) continue;
    const p = a.prospectId ? P.get(a.prospectId) : undefined;
    if (!p) continue;
    const sources = new Map((p.signals ?? []).map((s) => [s.key, s]));
    const reasons = (p.breakdown ?? [])
      .filter((b) => b.category === "fit" && b.weight > 0)
      .sort((x, y) => y.weight - x.weight)
      .map((b) => ({ label: b.label, text: opts.labels?.[b.key], source: sources.get(b.key)?.source ?? L(loc, "بيانات الشركة", "Company data"), url: sources.get(b.key)?.url }));
    const flags: string[] = [];
    if ((p.rejected?.length ?? 0) > 0) flags.push(L(loc, `${p.rejected!.length} معلومة بلا مصدر — استبعدتها ولم أذكرها`, `${p.rejected!.length} unsourced fact(s) — left out of the message`));
    if ((a.confidence ?? 1) < 0.75) flags.push(L(loc, "ثقتي في البحث متوسطة", "Research confidence is only medium"));
    if (Array.isArray(a.unresolved) && a.unresolved.length) flags.push(L(loc, "بعض الحقول ناقصة في الرسالة", "Some fields in the message are missing"));
    if (!p.persona) flags.push(L(loc, "قد لا يكون صاحب القرار", "May not be the decision maker"));
    const company = p.company ?? p.contact;
    const firstName = p.firstName ?? p.contact.split(" ")[0] ?? p.contact;
    const style: MessageStyle = { language, short: false, direct: false, avoid: [], mention: [] };
    const base = { company, firstName, firstNameAr: p.firstNameAr, reasons };
    const old = prev.get(`${company}|${p.contact}`);
    const st = old ? old.style : style;
    const composed = composeMessage(base, offer, st);
    items.push({
      id: a.id, prospectId: p.id, company, person: p.contact, firstName, firstNameAr: p.firstNameAr, title: p.title, city: p.city, employees: p.employees,
      score: p.score ?? null, max: p.scoreMax ?? null, reasons, unverified: p.rejected?.length ?? 0, flags,
      channel: a.channel as string | undefined, subject: composed.subject, body: composed.body, style: st,
      status: old?.status ?? (flags.length ? "needs_edit" : "ready"), edited: old?.edited ?? false, updatedAt: opts.now,
    });
  }
  items.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
  if (opts.policy) autoApprove(items, opts.policy, opts.now);
  return items;
}

/** Clean, pending items at or above the policy's score are approved. Returns how many. */
export function autoApprove(items: ReviewItem[], policy: ReviewPolicy, now: string): number {
  if (policy.mode !== "auto" || policy.autoAbove === undefined) return 0;
  let n = 0;
  for (const i of items) if (i.status === "ready" && (i.score ?? 0) >= policy.autoAbove) { i.status = "approved"; i.updatedAt = now; n++; }
  return n;
}

export function reviewCounts(items: ReviewItem[]) {
  const by = (s: ReviewStatus) => items.filter((i) => i.status === s).length;
  return { total: items.length, ready: by("ready"), approved: by("approved"), needsEdit: by("needs_edit"), excluded: by("excluded"), pending: by("ready") + by("needs_edit") };
}

// ---------------------------------------------------------------------------
// Selecting and acting on items

export function selectItems(items: ReviewItem[], f: ReviewFilter): ReviewItem[] {
  let out = items.filter((i) => (f.status ? f.status.includes(i.status) : i.status !== "excluded"));
  if (f.ids?.length) out = out.filter((i) => f.ids!.includes(i.id));
  if (f.names?.length) {
    const keys = f.names.map((n) => normalize(n));
    out = out.filter((i) => keys.some((k) => [i.company, i.person, i.firstName, i.firstNameAr ?? ""].some((v) => v && normalize(v).includes(k))));
  }
  if (f.cities?.length) out = out.filter((i) => i.city && f.cities!.includes(i.city));
  if (f.minScore !== undefined) out = out.filter((i) => (i.score ?? 0) >= f.minScore!);
  if (f.maxScore !== undefined) out = out.filter((i) => (i.score ?? 0) < f.maxScore!);
  if (f.lacksSignal) out = out.filter((i) => !i.reasons.some((r) => new RegExp(f.lacksSignal!, "i").test(normalize(r.label))));
  if (f.large) {
    const sizes = items.map((i) => i.employees ?? 0).sort((a, b) => a - b);
    const cut = sizes[Math.floor(sizes.length * 0.67)] ?? 0;
    out = out.filter((i) => (i.employees ?? 0) >= cut && (i.employees ?? 0) > 0);
  }
  if (f.top) out = [...out].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, f.top);
  return out;
}

/** Re-composes the selected messages with a changed style. Approved ones go back to review. */
export function rewriteItems(targets: ReviewItem[], ins: RewriteInstruction, offer: OfferText, now: string, single = false, noteLocale?: Locale) {
  const notes: string[] = [];
  let reopened = 0;
  for (const i of targets) {
    const style: MessageStyle = {
      language: ins.language ?? i.style.language,
      short: ins.short ?? i.style.short,
      direct: ins.direct ?? i.style.direct,
      avoid: [...new Set([...i.style.avoid, ...(ins.avoid ?? [])])],
      mention: [...new Set([...i.style.mention, ...(ins.mention ?? [])])],
    };
    const c = composeMessage(i, offer, style, noteLocale);
    notes.push(...c.notes);
    if (single) {
      i.pendingEdit = { subject: c.subject, body: c.body, notes: c.notes, style };
    } else {
      if (i.status === "approved") { i.status = i.flags.length ? "needs_edit" : "ready"; reopened++; }
      i.style = style;
      i.subject = c.subject;
      i.body = c.body;
      i.edited = true;
      i.pendingEdit = undefined;
    }
    i.updatedAt = now;
  }
  return { notes: [...new Set(notes)], reopened };
}

export function acceptEdit(i: ReviewItem, now: string) {
  if (!i.pendingEdit) return;
  i.body = i.pendingEdit.body;
  i.subject = i.pendingEdit.subject ?? i.subject;
  i.style = i.pendingEdit.style;
  i.pendingEdit = undefined;
  i.edited = true;
  if (i.status === "approved") i.status = "ready";
  i.updatedAt = now;
}
