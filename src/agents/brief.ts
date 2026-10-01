import type { CampaignConfig } from "../config/schema.js";
import type { Appointment, Message, Prospect } from "../domain/types.js";

/**
 * Prepares the brief for whoever attends an appointment: why the prospect
 * fits, why now, the sourced research behind it, how they qualified, and the
 * conversation so far. Built only from stored, sourced data.
 */
export function buildBrief(cfg: CampaignConfig, p: Prospect, messages: Message[]): Appointment["brief"] {
  const labels = new Map(cfg.qualification.criteria.map((c) => [c.key, c.label]));
  const breakdown = p.scoreBreakdown ?? [];
  return {
    whyFit: breakdown.filter((b) => b.category === "fit").map(({ label, weight }) => ({ label, weight })),
    whyNow: breakdown.filter((b) => b.category === "timing").map(({ label, weight }) => ({ label, weight })),
    signals: p.research?.signals ?? [],
    qualification: {
      met: (p.qualification?.met ?? []).map((k) => labels.get(k) ?? k),
      missing: (p.qualification?.missing ?? []).map((k) => labels.get(k) ?? k),
    },
    conversation: messages
      .filter((m) => m.prospectId === p.id)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((m) => ({ at: m.at, direction: m.direction, body: m.body })),
  };
}
