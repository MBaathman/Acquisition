import type { ActionMode, ActionType, Milestone } from "../config/actions.js";

/**
 * Core domain model. Deliberately generic: nothing here knows about a specific
 * client, industry or outcome. Industry-specific data lives in `attributes`,
 * declared per campaign in `fields`.
 */

export type Id = string;
export type Attributes = Record<string, unknown>;

/** All tenant data carries `clientId` so stores can enforce isolation. */
interface Tenanted {
  id: Id;
  clientId: Id;
}

export interface Account extends Tenanted {
  name: string;
  domain?: string;
  industry?: string;
  country?: string;
  city?: string;
  employees?: number;
  attributes: Attributes;
  externalIds: Record<string, string>;
}

export interface Contact extends Tenanted {
  accountId?: Id;
  firstName?: string;
  lastName?: string;
  title?: string;
  country?: string;
  city?: string;
  /** Reachability handles keyed by type: email, linkedin, phone, whatsapp... */
  handles: Record<string, string>;
  /** Channel keys this contact has consented to. */
  consents: string[];
  suppressed: boolean;
  attributes: Attributes;
  externalIds: Record<string, string>;
}

export type ProspectStatus =
  | "active" // engine is working it
  | "paused" // waiting on a human (escalation)
  | "parked" // scored below outreach threshold
  | "exhausted" // sequence finished without engagement
  | "converted"
  | "lost";

/** A researched fact. Every signal carries its source; unsourced claims are never stored. */
export interface ResearchSignal {
  key: string;
  value: unknown;
  source: string; // human-readable source name
  url?: string;
  confidence: number;
  at: string;
}

export type ResearchStatus = "needs_research" | "researching" | "complete" | "needs_review";
export type ContactStatus = "found" | "needs_contact" | "finding" | "not_found";

/** A contact's enrollment in one campaign — the unit the engine works on. */
export interface Prospect extends Tenanted {
  campaignId: Id;
  contactId: Id;
  accountId?: Id;
  status: ProspectStatus;
  stage: string;
  milestones: Partial<Record<Milestone, string>>; // milestone -> ISO time reached
  persona?: string;
  score?: number;
  tier?: string;
  scoreBreakdown?: { key: string; label: string; weight: number; category: "fit" | "timing" }[];
  /** Maximum attainable score for this campaign's model (100 when normalized). */
  scoreMax?: number;
  researchStatus: ResearchStatus;
  research?: {
    answers: Attributes;
    signals: ResearchSignal[];
    /** Required questions without a sourced answer. */
    missing: string[];
    /** Answers the provider returned without a source — discarded, kept only for review. */
    rejected: string[];
    confidence: number;
    at: string;
  };
  contactStatus: ContactStatus;
  qualification?: { qualified: boolean; met: string[]; missing: string[]; at: string };
  sequence: { startedAt?: string; nextStepIndex: number; stopped: boolean };
  touches: number;
  lastTouchAt?: string;
  lastIntent?: string;
  attributes: Attributes;
  createdAt: string;
  updatedAt: string;
}

export interface Message extends Tenanted {
  campaignId: Id;
  prospectId: Id;
  direction: "outbound" | "inbound";
  channel: string;
  kind: "sequence" | "response" | "conversion" | "reply";
  stepKey?: string;
  templateKey?: string;
  variantKey?: string;
  subject?: string;
  body: string;
  intent?: string;
  intentConfidence?: number;
  /** What the engine proposes after this reply (inbound only). */
  nextAction?: { kind: "respond" | "conversion_step" | "escalate" | "stop" | "wait"; summary: string; actionId?: string };
  externalId?: string;
  at: string;
}

export type AppointmentStatus = "scheduled" | "held" | "cancelled" | "no_show";

/** A scheduled session on the way to the outcome (a call, a viewing, a demo...). */
export interface Appointment extends Tenanted {
  campaignId: Id;
  prospectId: Id;
  status: AppointmentStatus;
  startsAt?: string;
  bookedAt: string;
  updatedAt: string;
  qualifiedAtBooking: boolean;
  /** Prepared for whoever attends: why fit, sourced signals, qualification reasons. */
  brief: {
    whyFit: { label: string; weight: number }[];
    whyNow: { label: string; weight: number }[];
    signals: ResearchSignal[];
    qualification: { met: string[]; missing: string[] };
    conversation: { at: string; direction: "inbound" | "outbound"; body: string }[];
  };
}

export interface OutcomeRecord extends Tenanted {
  campaignId: Id;
  prospectId?: Id;
  outcomeKey: string;
  /** Counted toward target (false when qualification was required but missing). */
  counted: boolean;
  value?: { amount: number; currency: string; recurrence: string };
  attribution: {
    firstTouch?: TouchRef;
    lastTouch?: TouchRef;
    /** Last outreach-sequence touch — the message that earned the conversation. */
    sourceTouch?: TouchRef;
    touches: number;
    persona?: string;
    tier?: string;
  };
  event: EventRecord;
  at: string;
}

export interface TouchRef {
  channel: string;
  stepKey?: string;
  templateKey?: string;
  variantKey?: string;
  at: string;
}

/** An external business event (payment, booking, form submit...) fed to the engine. */
export interface EventRecord {
  id: Id;
  clientId: Id;
  campaignId: Id;
  prospectId?: Id;
  type: string;
  payload: Attributes;
  at: string;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export type ActionStatus =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "scheduled" // deferred by rate limit / quiet hours / retry backoff
  | "executing"
  | "succeeded"
  | "failed"
  | "rejected" // by a human
  | "blocked" // by policy / permission / constraint
  | "cancelled";

export interface Actor {
  type: "agent" | "user" | "system";
  id: string;
  clientId?: Id;
  roles?: string[];
}

export interface Action extends Tenanted {
  campaignId: Id;
  prospectId?: Id;
  type: ActionType;
  /** Prevents the same logical action (e.g. step 2 to prospect X) from running twice. */
  idempotencyKey: string;
  payload: Attributes;
  confidence: number;
  rationale: string;
  proposedBy: Actor;
  mode?: ActionMode;
  status: ActionStatus;
  attempts: number;
  runAfter?: string;
  executedAt?: string;
  lastError?: string;
  result?: Attributes;
  decidedBy?: Actor;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: Id;
  clientId: Id;
  campaignId?: Id;
  actionId?: Id;
  prospectId?: Id;
  actor: Actor;
  event: string;
  detail: Attributes;
  at: string;
}

/** Something a human needs to look at — surfaced to the client as "needs attention". */
export interface ExceptionItem extends Tenanted {
  campaignId: Id;
  prospectId?: Id;
  actionId?: Id;
  kind: "escalation" | "action_failed" | "low_confidence" | "unqualified_outcome" | "policy";
  severity: "low" | "medium" | "high";
  reason: string;
  status: "open" | "resolved";
  at: string;
  resolvedAt?: string;
}

export interface Recommendation extends Tenanted {
  campaignId: Id;
  kind: string;
  summary: string;
  evidence: Attributes;
  /** Optional machine-applicable change (applied through an `optimize` action). */
  change?: { op: "disable_variant"; templateKey: string; variantKey: string } | { op: "raise_min_score"; value: number };
  status: "open" | "applied" | "dismissed";
  at: string;
}

export interface User {
  id: Id;
  clientId: Id;
  name: string;
  roles: string[]; // e.g. "approver", "viewer", "admin"
}

/** Mutable runtime state the engine learns/maintains per campaign (never edits the config file). */
export interface CampaignState extends Tenanted {
  /** `${templateKey}:${variantKey}` pairs switched off by the optimizer. */
  disabledVariants: string[];
  minScoreOverride?: number;
  discoveryCursor?: string;
  sourceExhausted?: boolean;
  lastOptimizedAt?: string;
}
