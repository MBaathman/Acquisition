// Minimal backend: the only process that may call a model. The browser sends a
// sentence, gets back a structured plan, and from then on works with stored data.
//
//   npm run server          (ANTHROPIC_API_KEY set → hybrid; unset → rules only)
//
// POST /api/plans                    {request, locale}       understand (rules first, model only if needed)
// GET  /api/plans/:id                                        stored plan — no model call
// POST /api/plans/:id/answers        {questionId, value}     re-plan from stored extraction — no model call
// POST /api/plans/:id/assumptions    {assumptionId, status}  no model call
// POST /api/plans/:id/approve                                build config, register campaign, start background work
// GET  /api/campaigns/:id/report                             client report — no model call
// GET  /api/usage?clientId=&campaignId=                      model calls, cache hits, tokens
//
// Authentication, tenancy checks and a durable store/queue are production work
// (see docs/ARCHITECTURE.md); this server binds to localhost by default.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AcquisitionEngine, AttributeResearchProvider, IntelligenceService, KeywordReplyClassifier, LlmComposer, LlmReplyClassifier,
  OutboxSender, PlanService, StaticProspectSource, createMemoryStore, summarizeCampaign, systemClock,
  type BuilderPresets, type Collection, type InMemoryQueue, type Knowledge, type Locale,
} from "../src/index.js";
import { AnthropicProvider } from "./anthropic-provider.js";

const ROOT = join(import.meta.dirname, "..");
const DATA = process.env.DATA_DIR ?? join(ROOT, "data");
const readJson = (f: string) => JSON.parse(readFileSync(join(ROOT, "presets", f), "utf8"));

/** A collection persisted to one JSON file (enough for a single-process server). */
class JsonFileCollection<T extends { id: string }> implements Collection<T> {
  private items: Map<string, T>;
  constructor(private readonly file: string) {
    this.items = new Map(existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T[]).map((v) => [v.id, v]) : []);
  }
  async get(id: string) { const v = this.items.get(id); return v && structuredClone(v); }
  async put(item: T) { this.items.set(item.id, structuredClone(item)); writeFileSync(this.file, JSON.stringify([...this.items.values()])); return item; }
  async find(pred: (item: T) => boolean) { return [...this.items.values()].filter(pred).map((v) => structuredClone(v)); }
  async findOne(pred: (item: T) => boolean) { for (const v of this.items.values()) if (pred(v)) return structuredClone(v); return undefined; }
}

mkdirSync(DATA, { recursive: true });
const store = {
  ...createMemoryStore(),
  plans: new JsonFileCollection<never>(join(DATA, "plans.json")),
  llmCalls: new JsonFileCollection<never>(join(DATA, "llm-calls.json")),
  llmCache: new JsonFileCollection<never>(join(DATA, "llm-cache.json")),
} as ReturnType<typeof createMemoryStore>;

const knowledge: Knowledge = readJson("knowledge.json");
const presets: BuilderPresets = { outcomes: readJson("outcomes.json").presets, intents: readJson("replies.json").intents };
const provider = process.env.ANTHROPIC_API_KEY ? new AnthropicProvider({ model: process.env.LLM_MODEL }) : undefined;
const ai = new IntelligenceService({ provider, calls: store.llmCalls, cache: store.llmCache, clock: systemClock });

const outbox = new OutboxSender();
const engine = new AcquisitionEngine(
  {
    clock: systemClock,
    sources: { apollo: new StaticProspectSource([]), crm_import: new StaticProspectSource([]) },
    research: { default: new AttributeResearchProvider() },
    channels: { email: outbox, linkedin: outbox },
    classifier: new LlmReplyClassifier(ai, new KeywordReplyClassifier()),
    composer: provider ? new LlmComposer(ai) : undefined,
  },
  { store },
);

const clients = new Map<string, { id: string; name: string }>();
const plans = new PlanService({
  plans: store.plans,
  presets,
  clock: systemClock,
  ai,
  ctx: (locale: Locale) => ({ knowledge, outcomes: presets.outcomes, clients: [...clients.values()], locale }),
});

// Background work: due jobs (ticks, approved actions, retries, follow-ups) run on the queue, not on requests.
setInterval(() => void (engine.queue as InMemoryQueue).runDue().catch((e) => console.error("queue", e)), 30_000).unref();

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  try {
    if (parts[0] !== "api") return send(res, 404, { error: "not found" });
    const [, resource, id, sub] = parts;

    if (req.method === "GET" && resource === "health") return send(res, 200, { ok: true, llm: provider ? provider.name : "rules-only" });

    if (resource === "plans") {
      if (req.method === "POST" && !id) {
        const b = await body(req);
        const request = String(b.request ?? "").trim().slice(0, 1000);
        if (!request) return send(res, 400, { error: "request is required" });
        return send(res, 201, await plans.create(request, b.locale === "en" ? "en" : "ar"));
      }
      if (req.method === "GET" && id && !sub) {
        const plan = await plans.get(id);
        return plan ? send(res, 200, plan) : send(res, 404, { error: "plan not found" });
      }
      if (req.method === "POST" && id && sub === "answers") {
        const b = await body(req);
        return send(res, 200, await plans.answer(id, String(b.questionId), String(b.value)));
      }
      if (req.method === "POST" && id && sub === "assumptions") {
        const b = await body(req);
        const status = b.status === "edited" ? "edited" : b.status === "accepted" ? "accepted" : "proposed";
        return send(res, 200, await plans.setAssumption(id, String(b.assumptionId), status));
      }
      if (req.method === "POST" && id && sub === "approve") {
        const { plan, config } = await plans.approve(id);
        clients.set(config.client.id, { id: config.client.id, name: config.client.name });
        await engine.registerCampaign(config);
        return send(res, 200, { plan, campaign: summarizeCampaign(config) });
      }
    }

    if (req.method === "GET" && resource === "campaigns" && id && sub === "report") return send(res, 200, await engine.report(id));

    if (req.method === "GET" && resource === "usage") {
      return send(res, 200, await ai.usage({ clientId: url.searchParams.get("clientId") ?? undefined, campaignId: url.searchParams.get("campaignId") ?? undefined }));
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`acquisition engine API on :${port} — ${provider ? "hybrid (rules + model)" : "rules only (set ANTHROPIC_API_KEY for the model)"}`);
});
