import type { DecisionFacts } from "./facts"
import type { Node, RuleDef } from "./types"

export interface KeyFactsReferral {
  reasonCode: "NO_BUREAU" | "MISSING_FACT"
  note: string
}

/** The facts a rule compares (isNull / notNull test for a missing fact on purpose, so they do not count). */
function comparedFields(node: Node, into: Set<keyof DecisionFacts>) {
  if ("field" in node) {
    if (node.op !== "isNull" && node.op !== "notNull") into.add(node.field)
    return
  }
  for (const child of [...(node.all ?? []), ...(node.any ?? [])]) comparedFields(child, into)
}

/**
 * Why the engine must hand a KEY_FACTS application to staff instead of approving it, or null.
 *
 * A rule never fires on a fact that is not known, so a rule set written for a bureau passes every bureau rule
 * for an application nobody bureau-checked. South Africa's staff approval path refuses a missing bureau
 * check itself; a key-facts application has no bureau, so nothing downstream would, and the engine would approve a
 * person nobody assessed. A key-facts application is therefore referred when it has no bureau check, and
 * when any fact a rule compares is missing. Pure.
 */
export function keyFactsReferral(input: {
  regime: string | null | undefined
  bureauCheckId: string | null
  facts: DecisionFacts
  rules: readonly RuleDef[]
}): KeyFactsReferral | null {
  if (input.regime !== "KEY_FACTS") return null
  if (!input.bureauCheckId) {
    return { reasonCode: "NO_BUREAU", note: "A key-facts application has no bureau check, so the engine cannot approve it; staff must decide." }
  }
  const fields = new Set<keyof DecisionFacts>()
  for (const rule of input.rules) comparedFields(rule.when, fields)
  const missing = [...fields].filter((field) => input.facts[field] === null)
  if (missing.length > 0) {
    return { reasonCode: "MISSING_FACT", note: `A rule compares a fact that is not known (${missing.join(", ")}), so the engine cannot approve; staff must decide.` }
  }
  return null
}
