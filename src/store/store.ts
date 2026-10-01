import type {
  Account,
  Appointment,
  CampaignState,
  Action,
  AuditEntry,
  Contact,
  EventRecord,
  ExceptionItem,
  Message,
  OutcomeRecord,
  Prospect,
  Recommendation,
  User,
} from "../domain/types.js";
import type { LlmCacheEntry, LlmCallRecord } from "../intelligence/types.js";
import type { CampaignPlan } from "../agent/planner.js";
import type { AgentApproval, CampaignRun, Conversation } from "../agent/agent.js";

/**
 * Persistence port. The in-memory implementation backs tests and demos; a
 * Postgres implementation can satisfy the same interface in production.
 */
export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(item: T): Promise<T>;
  find(pred: (item: T) => boolean): Promise<T[]>;
  findOne(pred: (item: T) => boolean): Promise<T | undefined>;
}

export interface Store {
  accounts: Collection<Account>;
  contacts: Collection<Contact>;
  prospects: Collection<Prospect>;
  messages: Collection<Message>;
  events: Collection<EventRecord>;
  outcomes: Collection<OutcomeRecord>;
  actions: Collection<Action>;
  audit: Collection<AuditEntry>;
  exceptions: Collection<ExceptionItem>;
  recommendations: Collection<Recommendation>;
  users: Collection<User>;
  campaignState: Collection<CampaignState>;
  appointments: Collection<Appointment>;
  /** Campaign plans produced from a natural-language request (persisted so viewing never re-plans). */
  plans: Collection<CampaignPlan>;
  /** Every model call (or cache hit / rules fallback): prompt, version, tokens, latency, status. */
  llmCalls: Collection<LlmCallRecord>;
  /** Validated model outputs keyed by prompt + version + input hash, reused for repeated requests. */
  llmCache: Collection<LlmCacheEntry>;
  /** Agent conversations: every message with its structured intents and the cards the agent replied with. */
  conversations: Collection<Conversation>;
  /** Campaigns the agent started from a plan: config, latest engine state, activity feed. */
  runs: Collection<CampaignRun>;
  /** Changes to running campaigns that wait for a human decision. */
  approvals: Collection<AgentApproval>;
}

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  private items = new Map<string, T>();
  async get(id: string) {
    const v = this.items.get(id);
    return v && structuredClone(v);
  }
  async put(item: T) {
    this.items.set(item.id, structuredClone(item));
    return item;
  }
  async find(pred: (item: T) => boolean) {
    return [...this.items.values()].filter(pred).map((v) => structuredClone(v));
  }
  async findOne(pred: (item: T) => boolean) {
    for (const v of this.items.values()) if (pred(v)) return structuredClone(v);
    return undefined;
  }
}

export function createMemoryStore(): Store {
  return {
    accounts: new MemoryCollection(),
    contacts: new MemoryCollection(),
    prospects: new MemoryCollection(),
    messages: new MemoryCollection(),
    events: new MemoryCollection(),
    outcomes: new MemoryCollection(),
    actions: new MemoryCollection(),
    audit: new MemoryCollection(),
    exceptions: new MemoryCollection(),
    recommendations: new MemoryCollection(),
    users: new MemoryCollection(),
    campaignState: new MemoryCollection(),
    appointments: new MemoryCollection(),
    plans: new MemoryCollection(),
    llmCalls: new MemoryCollection(),
    llmCache: new MemoryCollection(),
    conversations: new MemoryCollection(),
    runs: new MemoryCollection(),
    approvals: new MemoryCollection(),
  };
}
