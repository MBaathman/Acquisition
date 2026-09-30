import { evaluate } from "../config/evaluate.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Attributes } from "../domain/types.js";

export interface ScoreResult {
  fit: boolean;
  excluded: boolean;
  score: number;
  tier: string;
  persona?: string;
  breakdown: { key: string; weight: number }[];
}

/** Weighted-signal scoring normalised to 0..100 against the sum of positive weights. */
export function scoreProspect(cfg: CampaignConfig, ctx: Attributes): ScoreResult {
  const fit = evaluate(cfg.icp.fit, ctx);
  const excluded = cfg.icp.exclusions ? evaluate(cfg.icp.exclusions, ctx) : false;
  const breakdown = cfg.scoring.signals
    .filter((s) => evaluate(s.when, ctx))
    .map((s) => ({ key: s.key, weight: s.weight }));
  const raw = breakdown.reduce((sum, s) => sum + s.weight, 0);
  const maxPositive = cfg.scoring.signals.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  const score = maxPositive > 0 ? Math.max(0, Math.min(100, Math.round((raw / maxPositive) * 100))) : 0;
  const tier = [...cfg.scoring.tiers].sort((a, b) => b.min - a.min).find((t) => score >= t.min)?.key ?? "unscored";
  const persona = cfg.icp.personas.find((p) => evaluate(p.match, ctx))?.key;
  return { fit, excluded, score, tier, persona, breakdown };
}

export function qualify(cfg: CampaignConfig, ctx: Attributes) {
  const { criteria, minCriteriaMet } = cfg.qualification;
  const met = criteria.filter((c) => evaluate(c.when, ctx)).map((c) => c.key);
  const missing = criteria.filter((c) => !met.includes(c.key)).map((c) => c.key);
  const requiredOk = criteria.filter((c) => c.required).every((c) => met.includes(c.key));
  const qualified = criteria.length > 0 && requiredOk && met.length >= minCriteriaMet;
  return { qualified, met, missing };
}
