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

/** Keyword classifier driven by each campaign's configured intents. */
export class KeywordReplyClassifier implements ReplyClassifier {
  async classify({ campaign, text }: Parameters<ReplyClassifier["classify"]>[0]) {
    const lower = text.toLowerCase();
    let best = { intent: campaign.replies.defaultIntent, hits: 0 };
    for (const intent of campaign.replies.intents) {
      const hits = intent.keywords.filter((k) => lower.includes(k.toLowerCase())).length;
      if (hits > best.hits) best = { intent: intent.key, hits };
    }
    return { intent: best.intent, confidence: best.hits ? Math.min(0.95, 0.7 + 0.1 * best.hits) : 0.4 };
  }
}
