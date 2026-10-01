import type {
  ChannelSender,
  ContactFinder,
  ResearchFinding,
  Clock,
  DiscoveredProspect,
  OutboundMessage,
  ProspectSource,
  ReplyClassifier,
  ResearchProvider,
} from "./ports.js";

/**
 * Reference adapters for development, tests and demos. Production adapters
 * (Apollo/Clay discovery, LLM research & classification, email/LinkedIn/
 * WhatsApp senders) implement the same ports.
 */

export class ManualClock implements Clock {
  constructor(private t: Date) {}
  now() {
    return new Date(this.t);
  }
  set(t: Date) {
    this.t = new Date(t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** Serves a fixed list of prospects page by page. */
export class StaticProspectSource implements ProspectSource {
  constructor(private readonly prospects: DiscoveredProspect[]) {}
  async discover({ limit, cursor }: { limit: number; cursor?: string }) {
    const offset = Number(cursor ?? 0);
    const page = this.prospects.slice(offset, offset + limit);
    return { prospects: page, cursor: String(offset + page.length) };
  }
}

/**
 * Answers research questions from fixture data already on the account/contact.
 * Each attribute's source is read from `attributes._sources[key]`; values
 * without one are returned unsourced, which the engine discards.
 */
export class AttributeResearchProvider implements ResearchProvider {
  async research({ account, contact, questions }: Parameters<ResearchProvider["research"]>[0]) {
    const known = { ...(account?.attributes ?? {}), ...contact.attributes };
    const sources = { ...((account?.attributes._sources as SourceMap) ?? {}), ...((contact.attributes._sources as SourceMap) ?? {}) };
    const findings: ResearchFinding[] = questions
      .filter((q) => known[q.key] !== undefined)
      .map((q) => ({ key: q.key, value: known[q.key], source: sources[q.key]?.source, url: sources[q.key]?.url, confidence: sources[q.key]?.confidence }));
    return { findings };
  }
}

type SourceMap = Record<string, { source: string; url?: string; confidence?: number }>;

/** Returns handles stored on the fixture under `attributes._findable`. */
export class FixtureContactFinder implements ContactFinder {
  async find({ contact }: Parameters<ContactFinder["find"]>[0]) {
    const f = contact.attributes._findable as { handles: Record<string, string>; source: string } | undefined;
    return f ?? { handles: {} };
  }
}

/** Records messages instead of sending them. */
export class OutboxSender implements ChannelSender {
  readonly sent: OutboundMessage[] = [];
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    return { externalId: `out-${this.sent.length}` };
  }
}

/**
 * Keyword classifier driven by each campaign's configured intents. The most
 * specific match wins: a keyword found only inside a longer matched keyword
 * ("interested" inside "not interested") does not count.
 */
export class KeywordReplyClassifier implements ReplyClassifier {
  async classify({ campaign, text }: Parameters<ReplyClassifier["classify"]>[0]) {
    const lower = text.toLowerCase();
    const matches: { intent: string; start: number; end: number }[] = [];
    for (const intent of campaign.replies.intents) {
      for (const k of intent.keywords) {
        const kw = k.toLowerCase();
        for (let i = lower.indexOf(kw); i !== -1; i = lower.indexOf(kw, i + 1)) {
          matches.push({ intent: intent.key, start: i, end: i + kw.length });
        }
      }
    }
    const kept = matches.filter(
      (m) => !matches.some((o) => o !== m && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start),
    );
    const score = new Map<string, { hits: number; chars: number }>();
    for (const m of kept) {
      const s = score.get(m.intent) ?? { hits: 0, chars: 0 };
      score.set(m.intent, { hits: s.hits + 1, chars: s.chars + (m.end - m.start) });
    }
    const best = [...score.entries()].sort((a, b) => b[1].hits - a[1].hits || b[1].chars - a[1].chars)[0];
    if (!best) return { intent: campaign.replies.defaultIntent, confidence: 0.4 };
    return { intent: best[0], confidence: Math.min(0.95, 0.7 + 0.1 * best[1].hits) };
  }
}
