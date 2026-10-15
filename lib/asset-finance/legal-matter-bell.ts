import { createNotification } from "@/lib/notifications/bell"
import { isoOfDbDate } from "./dates"
import { nextLegalStepHint, type HintStep, type LegalRegime } from "./legal-matter-hint"
import type { SigningTx } from "./signing-prepare"

/** The legal-matter facts a bell item and the view are computed from. */
export async function loadHintSteps(tx: Pick<SigningTx, "legalMatterStep">, tenantId: string, matterId: string): Promise<HintStep[]> {
  const rows = await tx.legalMatterStep.findMany({
    where: { tenantId, matterId }, select: { id: true, kind: true, stepDate: true, correctsStepId: true },
    orderBy: [{ stepDate: "asc" }, { createdAt: "asc" }],
  })
  return rows.map((row) => ({ id: row.id, kind: row.kind, stepDate: isoOfDbDate(row.stepDate), correctsStepId: row.correctsStepId }))
}

/** The staff member who last appointed the matter's attorney (the matter itself does not record who). */
export async function attorneyAppointer(tx: Pick<SigningTx, "auditLog">, tenantId: string, matterId: string): Promise<string | null> {
  const row = await tx.auditLog.findFirst({
    where: { tenantId, action: "LEGAL_MATTER_ATTORNEY_APPOINTED", entity: "LegalMatter", entityId: matterId },
    orderBy: { createdAt: "desc" }, select: { userId: true },
  })
  return row?.userId ?? null
}

/**
 * Bell the next-step reminder to the matter's creator and attorney-appointer
 * (once each). Only the loan reference and a date are shown: no borrower
 * names or ID numbers. Returns how many items were written.
 */
export async function notifyNextLegalStep(tx: SigningTx, a: {
  tenantId: string
  matterId: string
  loanReference: string
  regime: LegalRegime
  recipients: readonly (string | null)[]
}): Promise<number> {
  const hint = nextLegalStepHint(a.regime, await loadHintSteps(tx, a.tenantId, a.matterId))
  if (!hint) return 0
  const recipients = [...new Set(a.recipients.filter((id): id is string => !!id))]
  for (const userId of recipients) {
    await createNotification({
      tenantId: a.tenantId, userId, type: "LEGAL_MATTER_NEXT_STEP", title: `Loan ${a.loanReference}: ${hint.text}`,
      entityType: "LegalMatter", entityId: a.matterId,
    }, tx.notification)
  }
  return recipients.length
}
