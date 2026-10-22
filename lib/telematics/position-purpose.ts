/**
 * Which purposes a loan has now for showing its asset's position (docs/asset-
 * finance/SLICE5.md part B, Deviation 3; SLICE5-FOLLOWUPS.md part T): DEFAULT
 * (the loan is DEFAULTED or PENDING_WRITE_OFF: in default, still collectable),
 * RECOVERY (an open recovery), LEGAL_MATTER (an OPEN matter), THEFT (a theft
 * report valid today on a running loan; the report's id is carried to the
 * access row). The reveal and the trail refuse on it, and the panels use it
 * to show the buttons only when they would answer. Reads no position. The
 * database holds the same rule at the access row ("telematicsPurposeHolds").
 */
import type { TelematicsPositionContext } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "@/lib/asset-finance/dates"
import { IN_DEFAULT, OPEN_RECOVERY } from "./alerts-raise"

export const PURPOSE_REFUSAL = "Position is shown only for a loan in default, legal action, recovery or a reported theft"
const CONTEXT_REFUSAL: Record<TelematicsPositionContext, string> = {
  DEFAULT: "This loan is not in default",
  RECOVERY: "This loan has no open recovery",
  LEGAL_MATTER: "This loan has no open legal matter",
  THEFT: "This loan has no theft report valid today",
}
/** A loan a theft report may be used on: still running (the same list as telematicsPurposeHolds). */
const RUNNING = ["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF"]

export type PositionPurposes = Record<TelematicsPositionContext, boolean> & { theftReportId: string | null }

export async function positionPurposes(tenantId: string, loan: { id: string; status: string }): Promise<PositionPurposes> {
  const [matters, recoveries, theft] = await Promise.all([
    prisma.legalMatter.count({ where: { tenantId, loanId: loan.id, status: "OPEN" } }),
    prisma.recovery.count({ where: { tenantId, loanId: loan.id, ...OPEN_RECOVERY } }),
    RUNNING.includes(loan.status)
      ? prisma.assetTheftReport.findFirst({
          where: { tenantId, loanId: loan.id, validUntil: { gte: dbDate(sastCalendarDate(new Date())) } },
          orderBy: { validUntil: "desc" }, select: { id: true },
        })
      : null,
  ])
  return {
    DEFAULT: (IN_DEFAULT as readonly string[]).includes(loan.status), RECOVERY: recoveries > 0, LEGAL_MATTER: matters > 0,
    THEFT: theft !== null, theftReportId: theft?.id ?? null,
  }
}

/** Why a reveal in `context` would be refused (409), or null when it would answer. */
export function purposeRefusal(purposes: PositionPurposes, context: TelematicsPositionContext): { reason: string; error: string } | null {
  if (!(purposes.DEFAULT || purposes.RECOVERY || purposes.LEGAL_MATTER || purposes.THEFT)) return { reason: "no_purpose", error: PURPOSE_REFUSAL }
  return purposes[context] ? null : { reason: `no_${context.toLowerCase()}`, error: CONTEXT_REFUSAL[context] }
}

/** The panels' reading: the refusal a reveal of this loan in `context` would give, or null (show the button). */
export async function positionRefusalFor(tenantId: string, loanId: string, context: TelematicsPositionContext): Promise<string | null> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId }, select: { id: true, status: true } })
  if (!loan) return PURPOSE_REFUSAL
  return purposeRefusal(await positionPurposes(tenantId, loan), context)?.error ?? null
}
