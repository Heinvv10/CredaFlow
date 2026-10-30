import type { Condition, Node } from "@/lib/decisioning/types"
import type { FactOption } from "./types"

const WORDS: Record<string, string> = {
  eq: "is", neq: "is not", gt: "is above", gte: "is at least", lt: "is below", lte: "is at most",
  between: "is between", in: "is one of", notIn: "is none of", isNull: "is missing", notNull: "is present",
}

function describeCondition(c: Condition, facts: FactOption[]): string {
  const label = facts.find((f) => f.name === c.field)?.label ?? c.field
  if (c.op === "isNull" || c.op === "notNull") return `${label} ${WORDS[c.op]}`
  const value = Array.isArray(c.value) ? (c.op === "between" ? c.value.join(" and ") : c.value.join(", ")) : String(c.value)
  return `${label} ${WORDS[c.op]} ${value}`
}

/** A rule's condition as one readable sentence. */
export function describeNode(node: Node, facts: FactOption[]): string {
  if ("field" in node) return describeCondition(node, facts)
  const children = (node.all ?? node.any ?? []).map((n) => describeNode(n, facts))
  const joiner = node.all ? " and " : " or "
  return children.length > 1 ? `(${children.join(joiner)})` : (children[0] ?? "")
}
