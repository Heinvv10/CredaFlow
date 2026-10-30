import { hasMinRole, type UserRole } from "@/lib/permissions"
import type { ApplicationFacts, Delegation, MatrixLevel, MatrixPayload, MatrixRule } from "./types"

function ruleMatches(rule: MatrixRule, facts: ApplicationFacts): boolean {
  const when = rule.when
  if (when.amountMinCents != null && facts.amountCents < when.amountMinCents) return false
  if (when.amountMaxCents != null && facts.amountCents > when.amountMaxCents) return false
  if (when.productIds && when.productIds.length > 0 && !when.productIds.includes(facts.productId)) return false
  if (when.branchIds && when.branchIds.length > 0 && (facts.branchId === null || !when.branchIds.includes(facts.branchId))) return false
  const byRank = when.riskGradeRankMin != null
  const byUngraded = when.ungraded === true
  if (byRank || byUngraded) {
    const worseOrEqual = byRank && facts.riskGradeRank !== null && facts.riskGradeRank >= (when.riskGradeRankMin as number)
    const ungradedMatch = byUngraded && facts.riskGradeRank === null
    if (!worseOrEqual && !ungradedMatch) return false
  }
  return true
}

/**
 * How many levels must approve an application: the most demanding of the rules it matches (the matrix is cautious, never
 * the first match), or the default when none does. Pure; the caller reads the facts from the application.
 */
export function requiredLevelsFor(matrix: Pick<MatrixPayload, "rules" | "defaultRequiredLevels">, facts: ApplicationFacts): { requiredLevels: number; matchedRuleIds: string[] } {
  const matched = matrix.rules.filter((rule) => ruleMatches(rule, facts))
  if (matched.length === 0) return { requiredLevels: matrix.defaultRequiredLevels, matchedRuleIds: [] }
  return { requiredLevels: Math.max(...matched.map((rule) => rule.requiredLevels)), matchedRuleIds: matched.map((rule) => rule.id) }
}

/** The highest level whose role the user's role reaches (0: none). */
export function roleLevel(levels: readonly MatrixLevel[], role: UserRole): number {
  let held = 0
  for (const level of levels) if (hasMinRole(role, level.role)) held = Math.max(held, level.level)
  return held
}

/**
 * The delegated level in force for an application of this amount: the highest of the delegations inside their dates and
 * limit and not revoked. A delegator's own current level caps what they can pass on (`delegatorLevels`, by delegator id;
 * absent means uncapped): a delegator who has since lost a level cannot keep delegating it.
 */
export function delegatedLevel(
  delegations: readonly Delegation[], amountCents: number, now: Date, delegatorLevels?: Record<string, number>,
): { level: number; delegationId: string } | null {
  let best: { level: number; delegationId: string } | null = null
  for (const d of delegations) {
    if (d.revokedAt !== null || now < d.validFrom || now > d.validTo || amountCents > d.maxAmountCents) continue
    const cap = delegatorLevels?.[d.delegatorId]
    const level = cap === undefined ? d.level : Math.min(d.level, cap)
    if (level <= 0) continue
    if (best === null || level > best.level) best = { level, delegationId: d.id }
  }
  return best
}

export interface Authority {
  level: number
  via: "ROLE" | "DELEGATION"
  delegationId: string | null
}

/** What a user may approve on an application: the higher of their role's level and any delegated one. */
export function authorityLevel(input: {
  role: UserRole; levels: readonly MatrixLevel[]; delegations: readonly Delegation[]; amountCents: number; now: Date; delegatorLevels?: Record<string, number>
}): Authority {
  const byRole = roleLevel(input.levels, input.role)
  const delegated = delegatedLevel(input.delegations, input.amountCents, input.now, input.delegatorLevels)
  if (delegated && delegated.level > byRole) return { level: delegated.level, via: "DELEGATION", delegationId: delegated.delegationId }
  return { level: byRole, via: "ROLE", delegationId: null }
}
