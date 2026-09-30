import { evaluate, getPath } from "../config/evaluate.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Attributes } from "../domain/types.js";

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|\s*"([^"]*)")?\s*\}\}/g;

/**
 * Renders `{{path}}` placeholders against the evaluation context. Supports
 * fallbacks (`{{contact.firstName | "there"}}`) and rule-selected snippets
 * (`{{snippet.hook}}`). Unresolved placeholders lower message confidence.
 */
export function render(text: string, ctx: Attributes, cfg: CampaignConfig) {
  const unresolved: string[] = [];
  const out = text.replace(PLACEHOLDER, (_m, path: string, fallback?: string) => {
    let value: unknown;
    if (path.startsWith("snippet.")) {
      const key = path.slice("snippet.".length);
      const snippet = cfg.personalization.snippets.find((s) => s.key === key && evaluate(s.when, ctx));
      value = snippet ? render(snippet.text, ctx, cfg).text : undefined;
    } else {
      value = getPath(ctx, path);
    }
    if (value === undefined || value === null || value === "") {
      if (fallback !== undefined) return fallback;
      unresolved.push(path);
      return "";
    }
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), unresolved };
}

export function renderVariant(
  variant: { subject?: string; body: string },
  ctx: Attributes,
  cfg: CampaignConfig,
) {
  const body = render(variant.body, ctx, cfg);
  const subject = variant.subject ? render(variant.subject, ctx, cfg) : undefined;
  const unresolved = [...body.unresolved, ...(subject?.unresolved ?? [])];
  return { subject: subject?.text, body: body.text, unresolved };
}
