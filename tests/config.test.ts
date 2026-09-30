import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigError, evaluate, loadCampaignDir, parseCampaignConfig } from "../src/index.js";
import { CAMPAIGNS, DATASPEAKS } from "./helpers.js";

describe("campaign configs", () => {
  it("validates every shipped campaign, each with a different outcome", async () => {
    const configs = await loadCampaignDir(CAMPAIGNS);
    expect(configs.map((c) => c.outcome.key).sort()).toEqual(["paid_subscriber", "qualified_lead", "qualified_meeting"]);
  });

  it("rejects configs with dangling references", async () => {
    const raw = parse(await readFile(DATASPEAKS, "utf8"));
    raw.outreach.sequence[0].template = "does_not_exist";
    raw.replies.defaultIntent = "nope";
    expect(() => parseCampaignConfig(raw)).toThrow(ConfigError);
    try {
      parseCampaignConfig(raw);
    } catch (e) {
      const issues = (e as ConfigError).issues.join("\n");
      expect(issues).toContain("unknown template 'does_not_exist'");
      expect(issues).toContain("unknown intent 'nope'");
    }
  });

  it("rejects per-action autonomy overrides for unknown action types", async () => {
    const raw = parse(await readFile(DATASPEAKS, "utf8"));
    raw.autonomy.actions = { launch_rockets: { mode: "autonomous" } };
    expect(() => parseCampaignConfig(raw)).toThrow(ConfigError);
  });
});

describe("rule evaluator", () => {
  const ctx = { account: { employees: 120, country: "SA", tags: ["b2b", "saas"] }, contact: { title: "Head of Data" } };
  it.each([
    [{ field: "account.employees", op: "between", value: [100, 200] }, true],
    [{ field: "account.country", op: "in", value: ["sa", "ae"] }, true],
    [{ field: "contact.title", op: "containsAny", value: ["analytics", "data"] }, true],
    [{ field: "account.tags", op: "eq", value: "saas" }, true],
    [{ field: "account.missing", op: "exists" }, false],
    [{ not: { field: "account.employees", op: "lt", value: 50 } }, true],
    [{ any: [{ field: "contact.title", op: "matches", value: "^ceo" }, { always: true }] }, true],
    [{ all: [{ field: "account.employees", op: "gte", value: 500 }, { always: true }] }, false],
  ] as const)("%j → %s", (rule, expected) => {
    expect(evaluate(rule as never, ctx)).toBe(expected);
  });
});

describe("core genericity", () => {
  it("engine source never hard-codes a client, industry or outcome", async () => {
    const forbidden = /\b(dataspeaks|tatimmah|real[\s_-]?estate|subscribers?|meetings?|leads?)\b/i;
    const root = join(import.meta.dirname, "..", "src");
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const lines = (await readFile(join(root, f), "utf8")).split("\n");
      lines.forEach((line, i) => forbidden.test(line) && offenders.push(`${f}:${i + 1}: ${line.trim()}`));
    }
    expect(offenders).toEqual([]);
  });
});
