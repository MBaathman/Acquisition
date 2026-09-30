import type { CampaignConfig } from "../config/schema.js";
import type { Account, Attributes, Contact, Prospect } from "../domain/types.js";

/**
 * Integration ports. The engine talks only to these interfaces; concrete
 * providers (Apollo, Clay, Unipile, email/WhatsApp gateways, LLMs, payment or
 * calendar webhooks...) are adapters registered at startup, keyed by name.
 */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Thrown by adapters for failures worth retrying (timeouts, 429s, 5xx). */
export class TransientError extends Error {}

export interface DiscoveredProspect {
  account?: Omit<Account, "id" | "clientId" | "attributes" | "externalIds"> & {
    attributes?: Attributes;
    externalIds?: Record<string, string>;
  };
  contact: Omit<Contact, "id" | "clientId" | "accountId" | "attributes" | "externalIds" | "consents" | "suppressed"> & {
    attributes?: Attributes;
    externalIds?: Record<string, string>;
    consents?: string[];
  };
}

export interface ProspectSource {
  discover(input: {
    campaign: CampaignConfig;
    query: Record<string, unknown>;
    limit: number;
    /** Opaque cursor so sources can page across ticks. */
    cursor?: string;
  }): Promise<{ prospects: DiscoveredProspect[]; cursor?: string }>;
}

export interface ResearchProvider {
  research(input: {
    campaign: CampaignConfig;
    account?: Account;
    contact: Contact;
    questions: CampaignConfig["research"]["questions"];
  }): Promise<{ answers: Attributes; confidence: number; sources: string[] }>;
}

export interface OutboundMessage {
  channel: string;
  to: string;
  subject?: string;
  body: string;
  prospectId: string;
  campaignId: string;
}

export interface ChannelSender {
  send(msg: OutboundMessage): Promise<{ externalId: string }>;
}

export interface ReplyClassification {
  intent: string;
  confidence: number;
  /** Attributes the classifier extracted from the reply (budget, timeline...). */
  extracted?: Attributes;
}

export interface ReplyClassifier {
  classify(input: { campaign: CampaignConfig; prospect: Prospect; text: string }): Promise<ReplyClassification>;
}

/**
 * Optional LLM-backed writer. The default composer renders templates; an LLM
 * composer can rewrite them, returning its own confidence.
 */
export interface Composer {
  compose(input: {
    campaign: CampaignConfig;
    rendered: { subject?: string; body: string };
    context: Attributes;
  }): Promise<{ subject?: string; body: string; confidence: number }>;
}

export interface Adapters {
  clock: Clock;
  sources: Record<string, ProspectSource>;
  research: Record<string, ResearchProvider>;
  channels: Record<string, ChannelSender>;
  classifier: ReplyClassifier;
  composer?: Composer;
}
