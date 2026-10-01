# Acquisition Engine — Architecture

## What this is

An **autonomous, agentic acquisition system** sold as an outcome-based service.
It is not a CRM. A client states the business outcome they want. The engine
then works continuously in the background to produce that outcome:

```
Client subscribes → defines outcome → configures ICP, market, offer, constraints
  → engine discovers prospects → researches → scores → qualifies
  → personalizes → picks channel → sends → follows up
  → reads & classifies replies → handles routine conversation → re-qualifies
  → drives the outcome (booking link / trial / lead handoff)
  → tracks & attributes outcomes → learns → optimizes → reports to the client
```

## Principles

1. **One generic core; clients differ only in configuration.** The engine never
   names a client, industry or outcome type. A test (`tests/config.test.ts`,
   "core genericity") fails the build if one appears in `src/`.
2. **Outcome is a first-class, configurable concept.** Paid subscriber,
   qualified meeting and qualified lead are all the same `outcome` block with a
   different `achievedWhen` rule, value, target and conversion step.
3. **Every agent step is a governed action.** Nothing the engine does bypasses
   the Action Gateway.
4. **Autonomy is a dial, not a rewrite.** `human_approval → assisted →
   autonomous` is one config field (plus optional per-action overrides).
5. **Background-first.** Work runs as jobs on a queue (recurring campaign ticks,
   prospect advancement, reply processing, retries, scheduled follow-ups). The
   client never triggers individual steps.
6. **The client sees outcomes, not workflow.** Reporting shows outcome progress,
   pipeline, results, attribution, recommendations and exceptions.

## Layers

```
campaigns/*.yaml ──► config/ (schema, rule language, loader, validation)
                        │
                        ▼
engine/engine.ts  ── the loop: tick → plan → propose ─────────────┐
   │                                                              ▼
agents/           governance/gateway.ts   (the only way to act)
 context          ├ idempotency             ├ permission (actor, allowedActions, tenant)
 scoring          ├ policies & constraints  ├ autonomy mode + confidence threshold
 personalization  ├ approval queue          ├ rate limits (sliding window)
 learning         ├ execute + retry/backoff ├ audit log (append-only)
                  └ failure → exception / escalation → prospect paused
   │
adapters/ports.ts ── ProspectSource · ResearchProvider · ChannelSender
                     ReplyClassifier · Composer · Clock
store/store.ts    ── persistence port (in-memory now; Postgres later)
runtime/queue.ts  ── job queue port   (in-memory now; durable queue later)
reporting/        ── client-facing report
```

### Domain model

| Entity | Purpose |
| --- | --- |
| Client | Tenant. All data is keyed by `clientId`. |
| Campaign (config) | Outcome, ICP, market, offer, discovery, research, scoring, qualification, funnel, personalization, outreach, replies, autonomy, constraints, escalation, optimization. |
| Account / Contact | Who we target. Industry-specific data lives in `attributes`, declared in `fields`. `targetType: individual` supports consumer-style campaigns with no account. |
| Prospect | A contact's enrollment in one campaign — the unit the engine works on (status, stage, milestones, score, research, qualification, sequence position). |
| Message | Outbound touches and inbound replies (intent + confidence). |
| EventRecord | External business facts (payment, meeting held, lead verified...). |
| OutcomeRecord | A credited outcome with value and first-, last- and sourcing-touch attribution. |
| Action | A governed agent step with confidence, rationale, mode, status, attempts. |
| AuditEntry | Every proposal, decision, execution, retry, failure, escalation. |
| ExceptionItem | What a human needs to look at ("needs attention"). |
| Recommendation | Learned, explainable optimization; applied through an `optimize` action. |
| CampaignState | Runtime learning state (disabled variants, min-score override, discovery cursor). The config file is never mutated. |

### Client → Campaign → Outcome

A client runs any number of campaigns (e.g. DataSpeaks: *UAE Agency
Acquisition* active, *KSA Agency Acquisition* draft). Each campaign has exactly
one outcome definition. Everything below the campaign (ICP, research, scoring,
outreach, replies, qualification, appointments, analytics, automation) is
campaign configuration.

### Research never fabricates

`ResearchProvider` returns findings; a finding is used only if it cites a
`source`. Unsourced findings are discarded (logged as `rejectedUnsourced` in
the audit trail) and the prospect is marked `needs_review`. Scoring and copy
read sourced research through `research.*`. Research status per prospect:
`needs_research → researching → complete | needs_review`.

### Scoring

Signals are weighted rules. `scale: points` publishes the raw total (the
DataSpeaks agency model totals 95); `scale: normalized` maps to 0..100. Each
signal is `fit` (why fit) or `timing` (why now). Persona is resolved before
signals are evaluated.

### Contacts

A fit prospect with no reachable handle goes through `enrich_contact`
(a `ContactFinder` adapter, handles must come with a source). Status:
`found | needs_contact | finding | not_found`; not found → parked.

### Outreach

First touch (`send_message`) and follow-ups (`follow_up`) are separate governed
actions, so follow-ups can be automated before first touches. Steps whose
channel the contact can't be reached on are skipped (audited). Upcoming touches
can be previewed as drafts (`previewNextTouch`) before they are proposed.

### Replies

Each inbound message stores its classification, confidence and the engine's
`nextAction` (respond, conversion step, escalate, wait, stop) with a link to
the proposed action holding the suggested response.

### Appointments

Optional `appointments` config (label "Meetings", "Viewings"...) maps business
events to an appointment lifecycle: scheduled → held | cancelled | no_show.
Each appointment carries a brief built only from stored, sourced data: why
fit, why now, research signals with sources, qualification, conversation.

### Milestones vs. funnel stages

The engine understands a fixed set of **milestones** (`discovered, researched,
fit, contacted, replied, engaged (positive reply), qualified, outcome, lost`).
Stages may instead be entered on a business event (`onEvent`, e.g. *Trial
started*, *Meeting booked*). Each campaign defines its own
client-facing **funnel stages** and maps them to milestones. The engine moves
prospects between stages without knowing what the stages are called.

### Rule language

All conditions (ICP fit, exclusions, personas, scoring signals, qualification
criteria, sequence-step conditions, snippet selection, escalation rules,
outcome achievement) use one declarative language:

```yaml
{ field: account.employees, op: between, value: [10, 1000] }
{ all: [...] } | { any: [...] } | { not: ... } | { always: true }
```

Operators: `eq neq in nin gt gte lt lte between contains containsAny matches exists missing`.
Fields are dot-paths into the evaluation context: `account.*`, `contact.*`,
`prospect.*`, `attributes.*` (merged custom fields), `research.*`,
`engagement.*`, `qualification.*`, `reply.*`, `event.*`, `offer.*`.

## Governance

Action types and their risk class (`src/config/actions.ts`):

| Action | Risk |
| --- | --- |
| discover, research, score, enrich_contact, qualify | internal |
| send_message, follow_up, respond, conversion_step | external |
| optimize | strategic |

Default mode per autonomy level:

| Level | internal | external | strategic | default min confidence |
| --- | --- | --- | --- | --- |
| human_approval (MVP) | autonomous | approval | approval | — |
| assisted | autonomous | autonomous if confidence ≥ 0.85, else approval | approval | 0.85 |
| autonomous | autonomous | autonomous if confidence ≥ 0.70, else approval | autonomous | 0.70 |

Per-action overrides: `autonomy.actions.<type>: { mode, minConfidence }`.
`engine.setAutonomy()` changes these at runtime; only client admins may, and
every change (and every denied attempt) is audited.
Hard permissions: `autonomy.allowedActions`. Human decisions require a user
of the same client with the `approver` or `admin` role; denials are audited.

Checks run twice — at proposal and again at execution — because state changes
in between (a prospect replies, opts out, a campaign is paused):

- **Block**: campaign not active, suppressed contact/domain/handle, missing
  handle, missing consent for consent-required channels, prospect paused/lost,
  sequence stopped, max touches.
- **Defer**: quiet hours (client timezone), minimum spacing between touches,
  rate limits (per action type / channel, per hour / day).
- **Retry**: adapters throw `TransientError` for retryable failures; exponential
  backoff per `constraints.retry`. Other errors fail immediately.
- **Failure**: raises an exception and pauses the prospect until a human
  resolves it (`resolveException(..., { resumeProspect: true })`).
- **Escalation**: low reply-classification confidence or any
  `escalation.rules` match raises an exception and (by default) pauses the prospect.
- **Idempotency**: each logical action has a key (`send:<prospect>:<step>`,
  `respond:<message>`...) so ticks and retries never duplicate work.

## Learning

`agents/learning.ts` builds per-arm stats (template variant, channel, score
tier) from touches, positive replies and outcomes. It:

- selects template variants and `auto` channels with a UCB1 bandit (queued
  touches count as allocations so a batch spreads across arms);
- produces explainable recommendations — retire an underperforming variant,
  raise the minimum score when a tier never converts — applied through a
  governed `optimize` action (approval-gated below full autonomy).

## The agent: chat is the primary interface

```
USER → NATURAL LANGUAGE → AGENT UNDERSTANDS → PLANS → EXECUTES → USER APPROVES IMPORTANT ACTIONS → AGENT REPORTS
```

The user talks to an acquisition agent (`src/agent/agent.ts`), not a form.
Every message becomes **structured intents** (`src/agent/intents.ts`), and the
agent acts on stored data:

| Intent | Example | What happens |
| --- | --- | --- |
| `new_goal` | "أبغى 100 عميل مدفوع لـDataSpeaks في الإمارات من وكالات التسويق" | understand → plan; a different goal opens its own conversation |
| `update_plan` `{changes}` | "خلها السعودية وركز على الرياض", "استخدم البريد فقط", "ارفع درجة التأهيل إلى 80" | plan rebuilt from the stored extraction + accumulated changes; reply shows the diff |
| `answer` | "جميع الأحجام" (to an open question) | applied; no form |
| `start` / `pause` / `resume` | "ابدأ البحث", "وقف الحملة", "استأنف" | campaign run created / status changed |
| `prepare_outreach` | "جهز التواصل لكن لا ترسل أي شيء بدون موافقتي" | drafts ready; policy confirmed (multi-intent message) |
| `query` | "وش لقيت؟", "ورني أفضل الفرص", "ليش اخترت هذي الشركات؟", "كم شركة عندك؟" | answered from stored engine data |
| `confirm` / `reject` | "اعتمد", "لا" | decides a pending change |

Data model: `Conversation` → `ConversationMessage` (text, `intents`,
`understoodBy`, ordered `cards`) · `CampaignPlan` (extraction, answers,
`changes`, assumptions, questions, strategy, draft) · `CampaignRun` (config,
counts, engine snapshot, activity feed) · `AgentApproval` (plan changes waiting
on a human). Cards are structured (plan, questions, diff, status, progress,
prospects, actions...) so any client can render them.

**Who decides what** (`DECISION_POLICY`):

- **AUTO** — finding, researching, scoring, prioritizing, drafting messages.
- **ASK** — at most two questions, only when the answer changes the plan
  (e.g. company size for agencies, public sector for enterprise, minimum budget
  for property, "did you mean the client you already have?"). Everything else
  is a stated assumption the user can change by saying so.
- **APPROVAL** — sending any real message (MVP), and major changes to a
  running campaign (market, goal, size, threshold, audience, looser autonomy):
  these become approvals in the chat and in the approvals center. Minor changes
  (language, channels, stricter approval) apply immediately.

Domain knowledge is data (`presets/knowledge.json`): outcome vocabulary,
markets, audience archetypes (signals, decision makers, the one question worth
asking, parameterized signals like "{n}+ clients"), answer aliases.
The prototype runs the engine's first cycle on fictional prospects (labelled
simulation); the server registers the campaign on the real engine.

The form-based setup remains as **advanced setup**, and the operational pages
(ICP, scoring, research, outreach, automation, audit...) as **advanced
details** — available, but not the way the product is run.

## Hybrid intelligence (LLM only where it adds something)

```
User → Frontend → Backend (server/) → IntelligenceService → LlmProvider → structured JSON
                                         │ cache · call log · token usage · schema validation
                                         └ deterministic fallback on every path
     → Database (Store) → engine workflows
```

| Concern | Where |
| --- | --- |
| Prompts, centralized and versioned, each with a zod output schema | `src/intelligence/prompts.ts` (`understand_goal`, `interpret_message`, `classify_reply`, `personalize_message`) |
| Provider port (replaceable) | `src/intelligence/types.ts` `LlmProvider` |
| Cache (prompt id + version + input hash), call log, token usage, fallback | `src/intelligence/service.ts` (`Store.llmCache`, `Store.llmCalls`, `usage()`) |
| Reply classification / personalization adapters | `src/intelligence/adapters.ts` (`LlmReplyClassifier` falls back to keywords and rejects unknown intents; `LlmComposer` only sees sourced facts) |
| Server-only provider (Anthropic SDK, structured outputs, refusal handling, server-side fallback) | `server/anthropic-provider.ts` — the only file that touches an API key, read from the environment |
| HTTP API | `server/index.ts` |

Rules:

- **No model call** on page open, navigation, tab change, filters, reports or
  approvals. The UI reads stored data.
- **Rules first.** A goal is sent to the model only if the rules could not
  find the audience, outcome or market (`rulesAreConfident`); a chat message
  only if the rules found no intent at all (`interpret_message`). Every skip is
  logged too (`status: skipped`), so usage shows how rarely the model is needed.
- **The model can't invent structure.** Its extraction is sanitized against
  the knowledge base (unknown archetypes, markets or outcomes are dropped);
  invalid answers are never cached; refusals and errors fall back to rules.
- **No key in a browser.** The prototype bundles the same service with no
  provider (rules only), or an optional host-provided edge model
  (`PromptJsonProvider`) that holds no key.
- Expensive work (research, drafting, classification) runs as queued
  background jobs, never in a request.

## Advanced setup flow (no-code campaign creation)

The friendly setup flow (Add client → Outcome → Audience → Offer →
Qualification → Channels → Control → Review → Launch) produces a
`CampaignDraft` — plain answers, no rule syntax. `buildCampaignConfig()`
(`src/config/builder.ts`) turns it into a full campaign config with smart
defaults and validates it with the same schema the engine loads YAML with:

- **Outcome types are data**: `presets/outcomes.json` (paid subscribers,
  qualified meetings, qualified leads, opportunities, custom). Each preset
  defines the confirming event, funnel stages, optional appointments and the
  default next-step message. Adding an outcome type = adding a preset.
- **Reply intents are data**: `presets/replies.json` (bilingual keywords).
- **Qualification criteria** become weighted scoring signals. A criterion is
  checked by sourced research (default — it only counts with a cited source),
  company size, job title or location.
- The prototype bundles the builder, schema validation and
  `summarizeCampaign()` for the browser (`src/browser.ts`), so a campaign
  created in the UI is a real, engine-valid config.

## Adding a new client or industry

Either use the setup flow (above), or:

1. Copy `campaigns/templates/real-estate-qualified-leads.yaml` (or another config).
2. Set client, campaign, outcome, ICP, fields, funnel, templates, channels, constraints.
3. `npm run validate`.
4. Register adapters for the configured `discovery.source`, `research.provider`
   and channels if they are new.

No engine code changes.

## Production roadmap

| Area | Now | Next |
| --- | --- | --- |
| Store | in-memory | Postgres implementation of `Store` (row-level tenant isolation) |
| Queue | in-memory | durable queue / workflow engine (pg-boss, BullMQ or Temporal) behind `JobQueue` |
| Discovery | static source | Apollo / Clay / Vibe Prospecting / CRM import adapters |
| Research, classification, writing | attribute lookup; keyword classifier + `LlmReplyClassifier`; templates + `LlmComposer` (server) | LLM-backed `ResearchProvider` with cited sources; eval sets per prompt |
| Plans / LLM log / cache | in-memory + JSON files (`server/`) | Postgres tables, per-client usage metering |
| Server | minimal Node HTTP (no auth) | authenticated API with tenant isolation |
| Channels | outbox | email (with warm-up + deliverability), LinkedIn (e.g. Unipile), WhatsApp BSP |
| Outcome events | `recordEvent()` | webhooks from payments (subscriptions), calendars (meetings), CRM (lead verification) |
| Client surface | `report()` | API + client portal: outcome, progress, pipeline, attribution, recommendations, approvals inbox, exceptions |
| Ops | — | per-client metering for outcome-based billing, alerting on exceptions, kill switch per campaign |
