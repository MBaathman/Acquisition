import { z } from "zod";

/**
 * Generic, declarative condition language used everywhere a campaign needs to
 * express "when X is true": ICP fit, exclusions, scoring signals, qualification
 * criteria, outcome achievement, reply routing.
 *
 * Fields are dot-paths into an evaluation context, e.g. `account.industry`,
 * `contact.title`, `attributes.budget`, `event.type`.
 */
export const OPERATORS = [
  "eq",
  "neq",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "containsAny",
  "matches",
  "exists",
  "missing",
] as const;

export type Operator = (typeof OPERATORS)[number];

export type Leaf = { field: string; op: Operator; value?: unknown };
export type Rule =
  | Leaf
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { always: true };

export const RuleSchema: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1), op: z.enum(OPERATORS), value: z.unknown().optional() }).strict(),
    z.object({ all: z.array(RuleSchema) }).strict(),
    z.object({ any: z.array(RuleSchema) }).strict(),
    z.object({ not: RuleSchema }).strict(),
    z.object({ always: z.literal(true) }).strict(),
  ]),
);
