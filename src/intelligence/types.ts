import type * as z from "zod/v4";

/**
 * The intelligence layer's ports. The engine and the agent never import a
 * model SDK: they call prompts through `IntelligenceService`, which talks to
 * whichever `LlmProvider` is registered (server-side only — API keys never
 * reach a browser). Swapping providers means writing one class.
 */

export type Effort = "low" | "medium" | "high";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmRequest<T> {
  promptId: string;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: Effort;
}

export interface LlmResponse<T> {
  output: T;
  model: string;
  usage: LlmUsage;
}

export interface LlmProvider {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>>;
}

/** The model declined to answer. The service falls back to rules. */
export class LlmRefusalError extends Error {}

export type LlmCallStatus = "ok" | "cached" | "rules" | "skipped" | "refused" | "invalid" | "error";

export interface LlmCallRecord {
  id: string;
  at: string;
  promptId: string;
  promptVersion: number;
  provider: string;
  model?: string;
  clientId?: string;
  campaignId?: string;
  /** ok = model answered; cached = reused; rules = no provider configured; skipped = rules were confident, model not needed; refused/invalid/error = model failed, rules answered. */
  status: LlmCallStatus;
  cacheKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  error?: string;
  /** The answer came from deterministic rules (no provider, or the model failed/refused/was invalid). */
  fallback: boolean;
}

export interface LlmCacheEntry {
  /** Cache key: hash of prompt id + version + input. */
  id: string;
  promptId: string;
  promptVersion: number;
  output: unknown;
  model: string;
  at: string;
  hits: number;
}
