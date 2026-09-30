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

| Config | Client | Outcome |
| --- | --- | --- |
| `campaigns/dataspeaks/paid-subscribers.yaml` | DataSpeaks | Paid Subscriber |
| `campaigns/tatimmah/qualified-meetings.yaml` | Tatimmah | Qualified Meeting |
| `campaigns/templates/real-estate-qualified-leads.yaml` | template | Qualified Lead |

A new client or industry is a new YAML file. No engine code changes.

## Commands

```bash
npm install
npm test           # unit + end-to-end + governance tests
npm run typecheck
npm run validate   # validate every campaign config
npm run demo       # run the active campaigns on one engine and print client reports
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.
