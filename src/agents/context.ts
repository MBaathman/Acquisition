import type { Milestone } from "../config/actions.js";
import type { CampaignConfig } from "../config/schema.js";
import type { Account, Attributes, Contact, Prospect } from "../domain/types.js";

/**
 * The evaluation context every rule, template and scorer sees. Config authors
 * reference these paths, e.g. `account.industry`, `contact.title`,
 * `attributes.budget`, `research.uses_bi_tool`, `engagement.lastIntent`.
 */
export function buildContext(input: {
  cfg: CampaignConfig;
  prospect: Prospect;
  contact: Contact;
  account?: Account;
  extra?: Attributes;
}): Attributes {
  const { cfg, prospect, contact, account } = input;
  return {
    client: cfg.client,
    campaign: cfg.campaign,
    offer: cfg.offer,
    market: cfg.market,
    account: account ?? {},
    contact,
    prospect,
    research: prospect.research?.answers ?? {},
    qualification: prospect.qualification ?? {},
    engagement: {
      touches: prospect.touches,
      lastIntent: prospect.lastIntent,
      replied: Boolean(prospect.milestones.engaged),
    },
    attributes: { ...(account?.attributes ?? {}), ...contact.attributes, ...prospect.attributes },
    ...input.extra,
  };
}

/** Advance a prospect's journey to a milestone and the funnel stage mapped to it (forward only). */
export function reachMilestone(prospect: Prospect, cfg: CampaignConfig, milestone: Milestone, at: string) {
  prospect.milestones[milestone] ??= at;
  const stages = cfg.funnel.stages;
  const target = stages.findIndex((s) => s.milestone === milestone);
  if (target === -1) return;
  const current = stages.findIndex((s) => s.key === prospect.stage);
  if (milestone === "lost" || target > current) prospect.stage = stages[target]!.key;
}
