import type { Composer, ReplyClassifier } from "../adapters/ports.js";
import { getPath } from "../config/evaluate.js";
import type { Attributes } from "../domain/types.js";
import { classifyReply, personalizeMessage } from "./prompts.js";
import type { IntelligenceService } from "./service.js";

/**
 * Reply classification through the intelligence layer. Without a provider (or
 * when the model fails) the deterministic classifier answers; an intent the
 * campaign doesn't define is never accepted.
 */
export class LlmReplyClassifier implements ReplyClassifier {
  constructor(private readonly ai: IntelligenceService, private readonly fallback: ReplyClassifier) {}

  async classify(input: Parameters<ReplyClassifier["classify"]>[0]) {
    const { campaign, text } = input;
    const keys = new Set(campaign.replies.intents.map((i) => i.key));
    const rules = () => this.fallback.classify(input).then((r) => ({ intent: r.intent, confidence: r.confidence, extracted: Object.entries(r.extracted ?? {}).map(([key, value]) => ({ key, value: String(value) })) }));
    const res = await this.ai.run(
      classifyReply,
      {
        text,
        intents: campaign.replies.intents.map((i) => ({ key: i.key, label: i.label ?? i.key, sentiment: i.sentiment })),
        defaultIntent: campaign.replies.defaultIntent,
      },
      { scope: { clientId: campaign.client.id, campaignId: campaign.campaign.id }, fallback: rules },
    );
    if (!keys.has(res.output.intent)) return this.fallback.classify(input);
    const extracted: Attributes = Object.fromEntries(res.output.extracted.map((e) => [e.key, e.value]));
    return { intent: res.output.intent, confidence: Math.max(0, Math.min(1, res.output.confidence)), extracted };
  }
}

/**
 * Personalization through the intelligence layer. Only sourced research facts
 * are passed to the model; without a provider the rendered template is kept.
 */
export class LlmComposer implements Composer {
  constructor(private readonly ai: IntelligenceService, private readonly opts: { minConfidence?: number } = {}) {}

  async compose({ campaign, rendered, context }: Parameters<Composer["compose"]>[0]) {
    const signals = (getPath(context, "prospect.research.signals") as { key: string; label?: string; value: unknown; source?: string }[] | undefined) ?? [];
    const question = (key: string) => campaign.research.questions.find((q) => q.key === key)?.prompt;
    const facts = signals.filter((s) => s.source).map((s) => ({ label: question(s.key) ?? s.label ?? s.key, value: String(s.value), source: s.source }));
    const res = await this.ai.run(
      personalizeMessage,
      {
        language: campaign.personalization.language,
        rendered,
        facts,
        offer: {
          name: campaign.offer.name,
          valueProposition: campaign.offer.valueProposition,
          callToAction: campaign.offer.callToAction,
        },
      },
      { scope: { clientId: campaign.client.id, campaignId: campaign.campaign.id }, fallback: () => ({ subject: rendered.subject ?? null, body: rendered.body, confidence: 1 }) },
    );
    const confidence = Math.max(0, Math.min(1, res.output.confidence));
    // A low-confidence rewrite is not worth the risk: keep the template.
    if (res.source !== "rules" && confidence < (this.opts.minConfidence ?? 0.5)) return { ...rendered, confidence: 1 };
    return { subject: res.output.subject ?? rendered.subject, body: res.output.body, confidence };
  }
}
