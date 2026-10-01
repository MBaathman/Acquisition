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
  };
}
