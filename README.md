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
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Prototype UI

`prototype/app.html` is the interface prototype (Arabic-first, RTL, English
toggle): first-time onboarding, add client, a 7-step campaign setup wizard, an
approvals center, and the client/operator workspaces. `npm run prototype` runs every campaign config on the
real engine with fictional prospects, exports the dataset and inlines it into
`prototype/dist/acquisition-os.html`. Everything it shows is DEMO DATA.

