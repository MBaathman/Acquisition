import type { CampaignConfig } from "../config/schema.js";
import type { Action } from "../domain/types.js";
import type { Store } from "../store/store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Sliding-window rate limits per campaign, action type and (optionally)
 * channel, counted from executed actions. Returns when the next slot opens.
 */
export async function checkRateLimit(input: {
  action: Action;
  cfg: CampaignConfig;
  store: Store;
  now: Date;
}): Promise<{ ok: true } | { ok: false; until: Date; reason: string }> {
  const { action, cfg, store, now } = input;
  const channel = typeof action.payload.channel === "string" ? action.payload.channel : undefined;
  const limits = cfg.constraints.rateLimits.filter(
    (l) => l.action === action.type && (!l.channel || l.channel === channel),
  );
  if (!limits.length) return { ok: true };

  const executed = await store.actions.find(
    (a) =>
      a.campaignId === action.campaignId &&
      a.type === action.type &&
      a.executedAt !== undefined &&
      now.getTime() - new Date(a.executedAt).getTime() < DAY,
  );

  for (const limit of limits) {
    const relevant = executed
      .filter((a) => !limit.channel || a.payload.channel === limit.channel)
      .map((a) => new Date(a.executedAt!).getTime())
      .sort((a, b) => a - b);
    for (const [max, window] of [
      [limit.perHour, HOUR],
      [limit.perDay, DAY],
    ] as const) {
      if (!max) continue;
      const inWindow = relevant.filter((t) => now.getTime() - t < window);
      if (inWindow.length >= max) {
        const oldest = inWindow[inWindow.length - max]!;
        return {
          ok: false,
          until: new Date(oldest + window),
          reason: `rate limit ${max}/${window === HOUR ? "hour" : "day"} for ${action.type}${limit.channel ? ` on ${limit.channel}` : ""}`,
        };
      }
    }
  }
  return { ok: true };
}
