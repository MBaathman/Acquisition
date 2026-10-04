# Acquisition Engine

A reusable, configuration-driven, **autonomous acquisition system** delivered as
an outcome-based service. Clients define the outcome they want (paid
subscribers, qualified meetings, qualified leads, or a custom outcome); the
engine discovers, researches, scores, reaches out, follows up, handles replies,
qualifies, drives conversions, learns and reports — continuously, in the background.

All autonomous actions pass through a governance gateway with permissions,
policies, campaign constraints, rate limits, confidence thresholds, retries,
failure handling, escalation and a full audit log. Autonomy is configured per
campaign: `human_approval` (MVP) → `assisted` → `autonomous`.

## Campaigns

| Config | Client — Campaign | Outcome |
| --- | --- | --- |
| `campaigns/dataspeaks/uae-agency-acquisition.yaml` | DataSpeaks — UAE Agency Acquisition | Paid Subscriber |
| `campaigns/dataspeaks/ksa-agency-acquisition.yaml` | DataSpeaks — KSA Agency Acquisition (draft) | Paid Subscriber |
| `campaigns/tatimmah/saudi-enterprise-outreach.yaml` | Tatimmah — Saudi Enterprise Outreach | Qualified Meeting |
| `campaigns/templates/real-estate-qualified-leads.yaml` | template | Qualified Lead |

A new client or industry is a new YAML file — or the answers to the setup
flow, which `buildCampaignConfig()` turns into the same validated config
using the outcome presets in `presets/`. No engine code changes.

## Commands

```bash
npm install
npm test           # unit + end-to-end + governance tests
npm run typecheck
npm run validate   # validate every campaign config
npm run demo       # run the active campaigns on one engine and print client reports
npm run prototype  # simulate September on the engine (demo data) and build prototype/dist/acquisition-os.html
npm run server     # backend API on :8787 (rules only; set ANTHROPIC_API_KEY for the hybrid model path)
```

## Talk to the agent

```
"أبغى 100 عميل مدفوع لـDataSpeaks في الإمارات من وكالات التسويق."
"خلها السعودية وركز على الرياض"
"ابدأ البحث"
"ورني وش لقيت"
"جهز التواصل لكن لا ترسل أي شيء بدون موافقتي"
"خل الرسائل أقصر وأكثر مباشرة"
"اعتمد الرسائل اللي تقييمها فوق 85"
"استبعد شركات دبي"
```

After a run the agent workspace shows the actual work — every prospect with
why it was picked (sourced), the agent's reservations and the proposed message —
and you approve, exclude or rewrite in place, by button or in the chat.

Chat is the primary interface. Each message becomes structured intents; the
agent plans, runs the engine, reports, and asks for approval only before
external or major actions. No forms are needed to run a campaign — the setup
form and operational pages remain as advanced options. See *The agent* and
*Hybrid intelligence* in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

The LLM API key lives only on the server (`ANTHROPIC_API_KEY`, read by
`server/anthropic-provider.ts`). Model calls are logged, cached, token-tracked
and always fall back to deterministic rules.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Prototype UI

`prototype/app.html` is the interface prototype (Arabic-first, RTL, English
toggle). It is chat-first: "وش تبغى نحقق؟" → conversation with the agent
(plan, questions, changes, start, results, policy) with a live "what is the
engine doing now?" panel and activity feed; approvals in one place. The engine
cycle runs on fictional prospects (simulation). The 7-step form and the
operational pages remain under "advanced". `npm run prototype` runs every campaign config on the
real engine with fictional prospects, exports the dataset and inlines it into
`prototype/dist/acquisition-os.html`. Everything it shows is DEMO DATA.

