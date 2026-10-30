import { hasMinRole, type UserRole } from "@/lib/permissions"
import { roleLevel } from "./evaluate"
import { APPROVER_ROLES, type MatrixLevel } from "./types"

export const MAX_DELEGATION_DAYS = 90
export const MIN_DELEGATION_REASON = 10
const DAY_MS = 86_400_000

export interface DelegationInput {
  delegatorId: string
  delegateId: string
  level: number
  maxAmountCents: number
  validFrom: Date
  validTo: Date
  reason: string
}

/**
 * Why a delegation cannot be made, or none. Authority can be passed on only from the role's own level (a delegate cannot pass on what was
 * delegated), only to someone who may approve at all, for an amount, for at most 90 days, starting no earlier than yesterday. Pure.
 */
export function delegationProblems(args: {
  input: DelegationInput; delegatorRole: UserRole; delegateRole: UserRole; levels: readonly MatrixLevel[]; now: Date
}): string[] {
  const { input, levels, now } = args
  const problems: string[] = []
  if (input.delegatorId === input.delegateId) problems.push("You cannot delegate authority to yourself.")
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > levels.length) problems.push(`The matrix has levels 1 to ${levels.length}.`)
  else if (roleLevel(levels, args.delegatorRole) < input.level) problems.push(`A delegation cannot exceed the delegator's own level (${roleLevel(levels, args.delegatorRole)}).`)
  if (!APPROVER_ROLES.some((role) => hasMinRole(args.delegateRole, role))) problems.push(`The delegate must hold at least the ${APPROVER_ROLES[0]} role, which is what approving an application needs.`)
  if (!Number.isInteger(input.maxAmountCents) || input.maxAmountCents <= 0 || input.maxAmountCents > 2_147_483_647) problems.push("Give the largest amount, in cents, the delegate may approve (a whole number above zero).")
  if (!(input.validTo.getTime() > input.validFrom.getTime())) problems.push("The delegation must end after it starts.")
  else if (input.validTo.getTime() <= now.getTime()) problems.push("The delegation's end is already past.")
  else if (input.validTo.getTime() - input.validFrom.getTime() > MAX_DELEGATION_DAYS * DAY_MS) problems.push(`A delegation lasts at most ${MAX_DELEGATION_DAYS} days.`)
  if (input.validFrom.getTime() < now.getTime() - DAY_MS) problems.push("The delegation's start is more than a day in the past: it cannot be backdated.")
  if (input.reason.trim().length < MIN_DELEGATION_REASON) problems.push(`Give the reason, in at least ${MIN_DELEGATION_REASON} characters.`)
  return problems
}
