import type { Clock } from "../adapters/ports.js";
import { buildCampaignConfig, type BuilderPresets } from "../config/builder.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Collection } from "../store/store.js";
import { understandGoal } from "../intelligence/prompts.js";
import type { IntelligenceService } from "../intelligence/service.js";
import { applyAnswer, buildPlan, extractGoal, sanitizeExtraction, type CampaignPlan, type GoalExtraction, type PlanAssumption, type PlannerContext } from "./planner.js";

/** Rules understood enough on their own: the model would add nothing. */
export function rulesAreConfident(x: GoalExtraction): boolean {
  return Boolean(x.archetype && x.outcome && x.countries.length);
}

/** Rules first; the model fills only what rules left empty. */
function merge(rules: GoalExtraction, llm: GoalExtraction): GoalExtraction {
  return {
    clientName: rules.clientName ?? llm.clientName,
    outcome: rules.outcome ?? llm.outcome,
    goal: rules.goal ?? llm.goal,
    countries: rules.countries.length ? rules.countries : llm.countries,
    cities: rules.cities.length ? rules.cities : llm.cities,
    archetype: rules.archetype ?? llm.archetype,
    audience: rules.audience ?? llm.audience,
    cta: rules.cta ?? llm.cta,
    autonomy: rules.autonomy ?? llm.autonomy,
  };
}

/**
 * Turns a request into a structured extraction: deterministic rules over the
 * knowledge base, and the model only when the rules could not understand the
 * audience, outcome or market. Answers are cached by the intelligence layer,
 * so the same sentence never costs twice.
 */
export async function understandRequest(
  request: string,
  ctx: PlannerContext,
  ai?: IntelligenceService,
  scope?: { clientId?: string },
): Promise<{ extraction: GoalExtraction; understoodBy: "rules" | "llm" }> {
  const rules = extractGoal(request, ctx);
  const input = {
    request,
    locale: ctx.locale,
    outcomes: ctx.outcomes.filter((o) => !o.custom).map((o) => ({ key: o.key, label: o.label.en })),
    regions: ctx.knowledge.regions.map((r) => ({ code: r.code, name: r.name.en, cities: r.cities.map((c) => c.key) })),
    archetypes: ctx.knowledge.archetypes.filter((a) => !a.fallback).map((a) => ({ key: a.key, label: a.label.en })),
    clients: (ctx.clients ?? []).map((c) => c.name),
  };
  if (!ai || rulesAreConfident(rules)) {
    if (ai) await ai.skipped(understandGoal, input, scope);
    return { extraction: rules, understoodBy: "rules" };
  }
  const res = await ai.run(understandGoal, input, { scope, fallback: () => rules });
  if (res.source === "rules") return { extraction: rules, understoodBy: "rules" };
  return { extraction: merge(rules, sanitizeExtraction(res.output, ctx)), understoodBy: "llm" };
}

/**
 * Plans are persisted the moment they are created. Viewing, answering a
 * question, accepting an assumption and approving all work on the stored
 * structure — none of them calls a model.
 */
export class PlanService {
  constructor(
    private readonly deps: {
      plans: Collection<CampaignPlan>;
      ctx: (locale: PlannerContext["locale"]) => PlannerContext;
      presets: BuilderPresets;
      clock: Clock;
      ai?: IntelligenceService;
    },
  ) {}

  async create(request: string, locale: PlannerContext["locale"]): Promise<CampaignPlan> {
    const ctx = this.deps.ctx(locale);
    const { extraction, understoodBy } = await understandRequest(request, ctx, this.deps.ai);
    const now = this.deps.clock.now().toISOString();
    const plan = buildPlan(extraction, ctx, { request, createdAt: now, understoodBy });
    plan.id = `${plan.id}-${now.replace(/\D/g, "").slice(0, 14)}`;
    await this.deps.plans.put(plan);
    return plan;
  }

  get(id: string) {
    return this.deps.plans.get(id);
  }

  async answer(id: string, questionId: string, value: string): Promise<CampaignPlan> {
    const plan = await this.require(id);
    const next = applyAnswer(plan, questionId, value, this.deps.ctx(plan.locale));
    await this.deps.plans.put(next);
    return next;
  }

  async setAssumption(id: string, assumptionId: string, status: PlanAssumption["status"]): Promise<CampaignPlan> {
    const plan = await this.require(id);
    plan.assumptions = plan.assumptions.map((a) => (a.id === assumptionId ? { ...a, status } : a));
    await this.deps.plans.put(plan);
    return plan;
  }

  /** Approve the plan: unanswered questions take their defaults; returns the engine-valid config. */
  async approve(id: string): Promise<{ plan: CampaignPlan; config: CampaignConfig }> {
    let plan = await this.require(id);
    for (const q of plan.questions) if (q.default) plan = applyAnswer(plan, q.id, q.default, this.deps.ctx(plan.locale));
    const config = buildCampaignConfig(plan.draft, this.deps.presets);
    plan = { ...plan, status: "approved", assumptions: plan.assumptions.map((a) => (a.status === "proposed" ? { ...a, status: "accepted" } : a)) };
    await this.deps.plans.put(plan);
    return { plan, config };
  }

  private async require(id: string) {
    const plan = await this.deps.plans.get(id);
    if (!plan) throw new Error(`plan ${id} not found`);
    return plan;
  }
}
