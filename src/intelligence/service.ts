import type { Clock } from "../adapters/ports.js";
import type { Collection } from "../store/store.js";
import { newId } from "../runtime/ids.js";
import type { PromptDef } from "./prompts.js";
import { LlmRefusalError, type LlmCacheEntry, type LlmCallRecord, type LlmCallStatus, type LlmProvider } from "./types.js";

/** Stable JSON (sorted keys) so equal inputs hash equally. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Two FNV-1a passes → 64-bit hex. Sync and dependency-free (runs in browsers too). */
export function hashKey(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export interface RunOptions<O> {
  scope?: { clientId?: string; campaignId?: string };
  /** Deterministic answer used when no provider is configured or the call fails. */
  fallback: () => O | Promise<O>;
  /** Default true. */
  cache?: boolean;
}

export interface RunResult<O> {
  output: O;
  source: "llm" | "cache" | "rules";
  callId: string;
}

export interface UsageSummary {
  calls: number;
  modelCalls: number;
  cacheHits: number;
  rulesOnly: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  byPrompt: Record<string, { calls: number; modelCalls: number; inputTokens: number; outputTokens: number }>;
}

/**
 * The single way the product talks to a model:
 *
 *   cache lookup → (no provider? rules) → provider call → schema validation
 *   → cache write → call log (tokens, latency, status) → on any failure: rules
 *
 * Every path is logged, so usage per client/campaign and cache efficiency are
 * observable, and the product keeps working with no model at all.
 */
export class IntelligenceService {
  constructor(
    private readonly deps: {
      provider?: LlmProvider;
      calls: Collection<LlmCallRecord>;
      cache: Collection<LlmCacheEntry>;
      clock: Clock;
      /** Cache lifetime; default 30 days. */
      cacheTtlMs?: number;
    },
  ) {}

  get hasProvider() {
    return Boolean(this.deps.provider);
  }

  cacheKey<I>(prompt: PromptDef<I, unknown>, input: I): string {
    return `${prompt.id}@${prompt.version}:${hashKey(stable(input))}`;
  }

  async run<I, O>(prompt: PromptDef<I, O>, input: I, opts: RunOptions<O>): Promise<RunResult<O>> {
    const { provider, cache, clock } = this.deps;
    const key = this.cacheKey(prompt, input);
    const started = clock.now().getTime();

    if (opts.cache !== false) {
      const hit = await cache.get(key);
      const fresh = hit && clock.now().getTime() - new Date(hit.at).getTime() < (this.deps.cacheTtlMs ?? 30 * 86_400_000);
      const valid = fresh && prompt.output.safeParse(hit.output);
      if (hit && valid && valid.success) {
        await cache.put({ ...hit, hits: hit.hits + 1 });
        const callId = await this.log(prompt, key, "cached", opts, { model: hit.model, latencyMs: 0 });
        return { output: valid.data, source: "cache", callId };
      }
    }

    if (!provider) {
      const callId = await this.log(prompt, key, "rules", opts, { latencyMs: 0 });
      return { output: await opts.fallback(), source: "rules", callId };
    }

    try {
      const res = await provider.complete({
        promptId: prompt.id,
        system: prompt.system,
        input: prompt.render(input),
        schema: prompt.output,
        maxTokens: prompt.maxTokens,
        effort: prompt.effort,
      });
      const parsed = prompt.output.safeParse(res.output);
      const latencyMs = clock.now().getTime() - started;
      if (!parsed.success) {
        const callId = await this.log(prompt, key, "invalid", opts, { model: res.model, latencyMs, usage: res.usage, error: parsed.error.message.slice(0, 300) });
        return { output: await opts.fallback(), source: "rules", callId };
      }
      if (opts.cache !== false) {
        await cache.put({ id: key, promptId: prompt.id, promptVersion: prompt.version, output: parsed.data, model: res.model, at: clock.now().toISOString(), hits: 0 });
      }
      const callId = await this.log(prompt, key, "ok", opts, { model: res.model, latencyMs, usage: res.usage });
      return { output: parsed.data, source: "llm", callId };
    } catch (err) {
      const status: LlmCallStatus = err instanceof LlmRefusalError ? "refused" : "error";
      const message = err instanceof Error ? err.message : String(err);
      const callId = await this.log(prompt, key, status, opts, { latencyMs: clock.now().getTime() - started, error: message.slice(0, 300) });
      return { output: await opts.fallback(), source: "rules", callId };
    }
  }

  /** Records that rules handled a request without needing the model. */
  async skipped<I>(prompt: PromptDef<I, unknown>, input: I, scope?: RunOptions<unknown>["scope"]): Promise<string> {
    return this.log(prompt, this.cacheKey(prompt, input), "skipped", { scope }, { latencyMs: 0 });
  }

  async usage(filter: { clientId?: string; campaignId?: string; since?: string } = {}): Promise<UsageSummary> {
    const calls = await this.deps.calls.find(
      (c) =>
        (!filter.clientId || c.clientId === filter.clientId) &&
        (!filter.campaignId || c.campaignId === filter.campaignId) &&
        (!filter.since || c.at >= filter.since),
    );
    const sum: UsageSummary = { calls: 0, modelCalls: 0, cacheHits: 0, rulesOnly: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, byPrompt: {} };
    for (const c of calls) {
      const model = c.status === "ok" || c.status === "invalid" || c.status === "refused";
      sum.calls += 1;
      if (c.status === "rules" || c.status === "skipped") sum.rulesOnly += 1;
      if (model) sum.modelCalls += 1;
      if (c.status === "cached") sum.cacheHits += 1;
      if (c.status === "error" || c.status === "invalid" || c.status === "refused") sum.failures += 1;
      sum.inputTokens += c.inputTokens;
      sum.outputTokens += c.outputTokens;
      sum.cacheReadTokens += c.cacheReadTokens;
      const p = (sum.byPrompt[c.promptId] ??= { calls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
      p.calls += 1;
      if (model) p.modelCalls += 1;
      p.inputTokens += c.inputTokens;
      p.outputTokens += c.outputTokens;
    }
    return sum;
  }

  private async log(
    prompt: PromptDef<never, unknown>,
    cacheKey: string,
    status: LlmCallStatus,
    opts: { scope?: RunOptions<unknown>["scope"] },
    d: { model?: string; latencyMs: number; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }; error?: string },
  ): Promise<string> {
    const rec: LlmCallRecord = {
      id: newId("llm"),
      at: this.deps.clock.now().toISOString(),
      promptId: prompt.id,
      promptVersion: prompt.version,
      provider: status === "rules" || status === "skipped" ? "rules" : this.deps.provider?.name ?? "none",
      model: d.model,
      clientId: opts.scope?.clientId,
      campaignId: opts.scope?.campaignId,
      status,
      cacheKey,
      inputTokens: d.usage?.inputTokens ?? 0,
      outputTokens: d.usage?.outputTokens ?? 0,
      cacheReadTokens: d.usage?.cacheReadTokens ?? 0,
      latencyMs: d.latencyMs,
      error: d.error,
      fallback: ["rules", "invalid", "refused", "error"].includes(status),
    };
    await this.deps.calls.put(rec);
    return rec.id;
  }
}
