import type {
  ChannelSender,
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

/** Answers research questions from values already present on the account/contact attributes. */
export class AttributeResearchProvider implements ResearchProvider {
  async research({ account, contact, questions }: Parameters<ResearchProvider["research"]>[0]) {
    const known = { ...(account?.attributes ?? {}), ...contact.attributes };
    const answers = Object.fromEntries(questions.filter((q) => known[q.key] !== undefined).map((q) => [q.key, known[q.key]]));
    const confidence = questions.length ? Object.keys(answers).length / questions.length : 1;
    return { answers, confidence, sources: ["attributes"] };
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
