import * as z from "zod/v4";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

/**
 * Provider for a platform-hosted model endpoint that takes one prompt and
 * returns parsed JSON (e.g. an edge function, or a host's built-in model call).
 * The page never holds a key: the endpoint authenticates on its side. The
 * output is still validated against the prompt's schema by the service.
 */
export class PromptJsonProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly call: (prompt: string) => Promise<unknown>,
    private readonly model = name,
  ) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const schema = JSON.stringify(z.toJSONSchema(req.schema));
    const prompt = `${req.system}\n\n${req.input}\n\nAnswer with one JSON object only, matching this JSON Schema:\n${schema}`;
    const output = (await this.call(prompt)) as T;
    // Edge endpoints don't report tokens; the call is still logged and cached.
    return { output, model: this.model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }
}
