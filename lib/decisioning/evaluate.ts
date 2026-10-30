import type { DecisionFacts } from "./facts"
import type { Condition, Group, Node, RuleDef, RuleHit, Scalar } from "./types"

const isCondition = (node: Node): node is Condition => "field" in node

function holds(fact: Scalar | null, cond: Condition): boolean {
  const { op, value } = cond
  if (op === "isNull") return fact === null
  if (op === "notNull") return fact !== null
  // A missing fact satisfies no comparison: a rule never fires on what is not known.
  // Authors test for a missing fact with isNull (or bureauAvailable) on purpose.
  if (fact === null) return false
  switch (op) {
    case "eq": return fact === value
    case "neq": return fact !== value
    case "gt": case "gte": case "lt": case "lte": {
      if (typeof fact !== "number" || typeof value !== "number") return false
      return op === "gt" ? fact > value : op === "gte" ? fact >= value : op === "lt" ? fact < value : fact <= value
    }
    case "between": {
      if (typeof fact !== "number" || !Array.isArray(value) || value.length !== 2) return false
      const [low, high] = value
      return typeof low === "number" && typeof high === "number" && fact >= low && fact <= high
    }
    case "in": return Array.isArray(value) && value.includes(fact)
    case "notIn": return Array.isArray(value) && !value.includes(fact)
    default: return false
  }
}

function evaluateNode(node: Node, facts: DecisionFacts): boolean {
  if (isCondition(node)) return holds(facts[node.field], node)
  const group = node as Group
  if (group.all) return group.all.length > 0 && group.all.every((child) => evaluateNode(child, facts))
  if (group.any) return group.any.some((child) => evaluateNode(child, facts))
  return false
}

/** The rules that fire for these facts, in the set's order. Pure. */
export function evaluateRules(rules: readonly RuleDef[], facts: DecisionFacts): RuleHit[] {
  return rules.filter((rule) => evaluateNode(rule.when, facts)).map((rule) => ({
    ruleId: rule.id,
    name: rule.name,
    outcome: rule.outcome,
    reasonCode: rule.reasonCode,
    ...(rule.declineCategory ? { declineCategory: rule.declineCategory } : {}),
    ...(rule.limitCapCents !== undefined ? { limitCapCents: rule.limitCapCents } : {}),
  }))
}
