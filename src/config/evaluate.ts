import type { Leaf, Rule } from "./rules.js";

/** Resolve a dot-path (`contact.attributes.budget`) against a context object. */
export function getPath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : v);
const eq = (a: unknown, b: unknown) => norm(a) === norm(b);

function evalLeaf(leaf: Leaf, ctx: unknown): boolean {
  const actual = getPath(ctx, leaf.field);
  const expected = leaf.value;
  switch (leaf.op) {
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "missing":
      return actual === undefined || actual === null || actual === "";
    case "eq":
      return Array.isArray(actual) ? actual.some((a) => eq(a, expected)) : eq(actual, expected);
    case "neq":
      return !eq(actual, expected);
    case "in":
      return Array.isArray(expected) && (Array.isArray(actual)
        ? actual.some((a) => expected.some((e) => eq(a, e)))
        : expected.some((e) => eq(actual, e)));
    case "nin":
      return !evalLeaf({ ...leaf, op: "in" }, ctx);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      return leaf.op === "gt" ? actual > expected
        : leaf.op === "gte" ? actual >= expected
        : leaf.op === "lt" ? actual < expected
        : actual <= expected;
    }
    case "between": {
      if (typeof actual !== "number" || !Array.isArray(expected)) return false;
      const [lo, hi] = expected as number[];
      return actual >= (lo ?? -Infinity) && actual <= (hi ?? Infinity);
    }
    case "contains":
      if (Array.isArray(actual)) return actual.some((a) => eq(a, expected));
      return typeof actual === "string" && typeof expected === "string" && actual.toLowerCase().includes(expected.toLowerCase());
    case "containsAny": {
      if (!Array.isArray(expected)) return false;
      return expected.some((e) => evalLeaf({ field: leaf.field, op: "contains", value: e }, ctx));
    }
    case "matches":
      return typeof actual === "string" && typeof expected === "string" && new RegExp(expected, "i").test(actual);
  }
}

export function evaluate(rule: Rule, ctx: unknown): boolean {
  if ("always" in rule) return true;
  if ("all" in rule) return rule.all.every((r) => evaluate(r, ctx));
  if ("any" in rule) return rule.any.some((r) => evaluate(r, ctx));
  if ("not" in rule) return !evaluate(rule.not, ctx);
  return evalLeaf(rule, ctx);
}
