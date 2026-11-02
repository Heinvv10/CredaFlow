import { loadOwnLenderDebts } from "@/lib/affordability/own-lender-debt-load"
import {
  InvalidAffordabilityDebtError,
  normaliseAffordabilityDebts,
  readAffordabilityDebtInputs,
  readAffordabilitySnapshotStore,
  totalAffordabilityDebt,
  type AffordabilityDebtInput,
} from "@/lib/affordability/snapshot"
import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"

type Db = Parameters<typeof loadOwnLenderDebts>[0]

export interface AttestationAffordabilityInput {
  tenantId: string
  applicationId: string
  clientId: string
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  /** LoanApplication.existingDebtObligations, as stored. */
  applicationDebts: unknown
  clientDebts: readonly AffordabilityDebtInput[]
  bureauObligationsCents: number
  instalmentCents: number | null
  ndiBufferPct: number
}

/** What each of this client's other open applications would add to their instalments; null when one has no recorded figure. */
async function openApplicationInstalments(db: Db, input: AttestationAffordabilityInput): Promise<number | null> {
  const open = await db.loanApplication.findMany({
    where: { tenantId: input.tenantId, clientId: input.clientId, id: { not: input.applicationId }, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } },
    select: { affordabilityResult: true },
  })
  let total = 0
  for (const application of open) {
    const instalment = readAffordabilitySnapshotStore(application.affordabilityResult).submission?.inputs.proposedInstalmentCents
    if (!Number.isSafeInteger(instalment)) return null
    total += instalment as number
  }
  return total
}

/**
 * Whether the engine may stand behind this application's affordability. The approval gate takes the higher of declared and
 * bureau debt, which is right for a person weighing a file, but a bureau cannot yet know of a loan this lender approved minutes
 * ago, so a sibling approval disappears into the bureau figure. With no person looking, every obligation counts on top: the
 * higher of the declared debts (without this lender's) and the bureau, plus this lender's loans and approved applications, plus
 * the client's other open applications. A loan both on the bureau and to this lender counts twice, on the safe side. Anything that
 * cannot be read answers false: the engine refers. Called on the engine's facts and again inside the approval's transaction, under
 * the client lock, so two applications approved at once see each other.
 */
export async function attestationAffordable(db: Db, input: AttestationAffordabilityInput): Promise<boolean> {
  if (input.instalmentCents === null) return false
  try {
    const own = await loadOwnLenderDebts(db, input.tenantId, input.clientId, input.applicationId)
    const open = await openApplicationInstalments(db, input)
    if (open === null) return false
    if (own.loans.some((loan) => !Number.isSafeInteger(loan.instalmentCents))) return false
    const declared = Math.max(
      totalAffordabilityDebt(normaliseAffordabilityDebts(readAffordabilityDebtInputs(input.applicationDebts))),
      totalAffordabilityDebt(normaliseAffordabilityDebts(input.clientDebts)),
    )
    const ownInstalments = own.loans.reduce((sum, loan) => sum + (loan.instalmentCents as number), 0)
    return !evaluateAffordabilityGate({
      monthlyIncomeCents: input.monthlyIncomeCents,
      monthlyExpensesCents: input.monthlyExpensesCents,
      declaredDebtCents: Math.max(declared, input.bureauObligationsCents) + ownInstalments + open,
      bureauObligationsCents: 0,
      proposedInstalmentCents: input.instalmentCents,
      ndiBufferPct: input.ndiBufferPct,
    }).blocked
  } catch (error) {
    if (error instanceof InvalidAffordabilityDebtError) return false
    throw error
  }
}
