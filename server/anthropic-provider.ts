// Server-only. The API key is read from the environment here and nowhere else;
// nothing under src/ or prototype/ imports this file, so it can never reach a browser.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LlmRefusalError, type LlmProvider, type LlmRequest, type LlmResponse } from "../src/intelligence/types.js";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly opts: { apiKey?: string; model?: string } = {}) {
    // The SDK reads ANTHROPIC_API_KEY from the environment when apiKey is omitted.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResponse<T>> {
    const res = await this.client.beta.messages.parse({
      model: this.opts.model ?? "claude-opus-5-5",
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.input }],
      output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
      // If the model declines, the API retries the request on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (res.stop_reason === "refusal") throw new LlmRefusalError(`${req.promptId}: model declined`);
    if (res.parsed_output === null) throw new Error(`${req.promptId}: no structured output (stop_reason=${res.stop_reason})`);
    return {
      output: res.parsed_output as T,
      model: res.model,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
