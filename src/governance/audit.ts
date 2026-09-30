import type { Actor, Attributes, AuditEntry } from "../domain/types.js";
import type { Clock } from "../adapters/ports.js";
import type { Store } from "../store/store.js";
import { newId } from "../runtime/ids.js";

export const SYSTEM_ACTOR: Actor = { type: "system", id: "engine" };
export const AGENT_ACTOR: Actor = { type: "agent", id: "acquisition-agent" };

/** Append-only audit trail. Every proposal, decision, execution and failure is recorded. */
export class AuditLog {
  constructor(private readonly store: Store, private readonly clock: Clock) {}

  async record(entry: {
    clientId: string;
    campaignId?: string;
    actionId?: string;
    prospectId?: string;
    actor: Actor;
    event: string;
    detail?: Attributes;
  }): Promise<AuditEntry> {
    const full: AuditEntry = { id: newId("aud"), detail: {}, ...entry, at: this.clock.now().toISOString() };
    return this.store.audit.put(full);
  }

  async trail(filter: { clientId: string; actionId?: string; prospectId?: string; campaignId?: string }) {
    const rows = await this.store.audit.find(
      (e) =>
        e.clientId === filter.clientId &&
        (!filter.actionId || e.actionId === filter.actionId) &&
        (!filter.prospectId || e.prospectId === filter.prospectId) &&
        (!filter.campaignId || e.campaignId === filter.campaignId),
    );
    return rows.sort((a, b) => a.at.localeCompare(b.at));
  }
}
