/**
 * Which purposes a loan has now for showing its asset's position (docs/asset-
 * finance/SLICE5.md part B, Deviation 3): DEFAULT (the loan is DEFAULTED),
 * RECOVERY (an open recovery), LEGAL_MATTER (an OPEN matter). The reveal
 * (position-view.ts) refuses on it, and the panels use it to show the button
 * only when the reveal would answer, or the reason instead. Reads no position.
 */
import type { TelematicsPositionContext } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { OPEN_RECOVERY } from "./alerts-raise"

export const PURPOSE_REFUSAL = "Position is shown only for a loan in default, legal action or recovery"
const CONTEXT_REFUSAL: Record<TelematicsPositionContext, string> = {
  DEFAULT: "This loan is not in default",
  RECOVERY: "This loan has no open recovery",
  LEGAL_MATTER: "This loan has no open legal matter",
}

export type PositionPurposes = Record<TelematicsPositionContext, boolean>

export async function positionPurposes(tenantId: string, loan: { id: string; status: string }): Promise<PositionPurposes> {
  const [matters, recoveries] = await Promise.all([
    prisma.legalMatter.count({ where: { tenantId, loanId: loan.id, status: "OPEN" } }),
    prisma.recovery.count({ where: { tenantId, loanId: loan.id, ...OPEN_RECOVERY } }),
  ])
  return { DEFAULT: loan.status === "DEFAULTED", RECOVERY: recoveries > 0, LEGAL_MATTER: matters > 0 }
}

/** Why a reveal in `context` would be refused (409), or null when it would answer. */
export function purposeRefusal(purposes: PositionPurposes, context: TelematicsPositionContext): { reason: string; error: string } | null {
  if (!Object.values(purposes).some(Boolean)) return { reason: "no_purpose", error: PURPOSE_REFUSAL }
  return purposes[context] ? null : { reason: `no_${context.toLowerCase()}`, error: CONTEXT_REFUSAL[context] }
}

/** The panels' reading: the refusal a reveal of this loan in `context` would give, or null (show the button). */
export async function positionRefusalFor(tenantId: string, loanId: string, context: TelematicsPositionContext): Promise<string | null> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, status: true } })
  if (!loan) return PURPOSE_REFUSAL
  return purposeRefusal(await positionPurposes(tenantId, loan), context)?.error ?? null
}
