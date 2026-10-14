import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { runScreening } from "./run"

/**
 * Screens the applicant when an application is submitted, so a PEP or
 * sanctions match reaches a reviewer before the credit officer gets to it.
 * Called fire-and-forget after the submission has committed.
 *
 * Never throws and never blocks the submission: the binding gate is the one at
 * approval (lib/screening/gate.ts), which re-runs screening itself when this
 * run is missing or stale. A failure here is logged and audited, not hidden.
 * An entity borrower (no clientId) is not screened here.
 */
export async function screenOnSubmit(args: {
  tenantId: string
  applicationId: string
  actor: { id: string; email: string } | null
}): Promise<void> {
  try {
    const application = await prisma.loanApplication.findFirst({
      where: { id: args.applicationId, tenantId: args.tenantId },
      select: { clientId: true },
    })
    if (!application?.clientId) return
    await runScreening({
      tenantId: args.tenantId,
      clientId: application.clientId,
      trigger: "APPLICATION_SUBMIT",
      applicationId: args.applicationId,
      actor: args.actor,
    })
  } catch (error) {
    console.error("[screening] submit-time run failed", {
      tenantId: args.tenantId,
      applicationId: args.applicationId,
      error: error instanceof Error ? error.name : typeof error,
    })
    // logAudit reports its own failure and does not rethrow; the outer
    // promise is fire-and-forget, so nothing here may reject.
    await logAudit({
      tenantId: args.tenantId,
      userId: args.actor?.id,
      userEmail: args.actor?.email,
      action: AuditAction.SCREENING_RUN_FAILED,
      entity: "LoanApplication",
      entityId: args.applicationId,
      newValue: { trigger: "APPLICATION_SUBMIT", error: error instanceof Error ? error.message : String(error) },
    }).catch((auditError: unknown) => {
      console.error("[screening] submit-time failure audit failed", {
        applicationId: args.applicationId,
        error: auditError instanceof Error ? auditError.name : typeof auditError,
      })
    })
  }
}
