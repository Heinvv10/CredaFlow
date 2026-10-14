import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { runScreening } from "./run"
import { borrowerSubjects } from "./subject"

type Actor = { id: string; email: string } | null
type Target = { applicationId: string } | { dealId: string }

async function applicationIdOf(tenantId: string, target: Target): Promise<string | null> {
  if ("applicationId" in target) return target.applicationId
  const deal = await prisma.assetFinanceDeal.findFirst({ where: { id: target.dealId, tenantId }, select: { applicationId: true } })
  return deal?.applicationId ?? null
}

/**
 * Screens an application's borrower when it is submitted — the client, or
 * the entity and every actively related person — so a PEP or sanctions match
 * reaches a reviewer before the credit officer gets to it. Takes an
 * application id, or an asset-finance deal id. Called fire-and-forget after
 * the submission has committed.
 *
 * Never throws and never blocks the submission: the binding gate is the one at
 * approval (lib/screening/gate.ts), which re-runs a missing, stale, errored or
 * identity-changed run itself. A failure is recorded as an audit row (the
 * codebase has no separate error reporter; logAudit never throws), not hidden.
 */
export async function screenOnSubmit(args: { tenantId: string; actor: Actor } & Target): Promise<void> {
  const target: Target = "dealId" in args ? { dealId: args.dealId } : { applicationId: args.applicationId }
  try {
    const applicationId = await applicationIdOf(args.tenantId, target)
    if (!applicationId) return
    const application = await prisma.loanApplication.findFirst({
      where: { id: applicationId, tenantId: args.tenantId },
      select: { clientId: true, entityId: true },
    })
    if (!application) return
    for (const subject of await borrowerSubjects(prisma, args.tenantId, application)) {
      const ran = await runScreening({ tenantId: args.tenantId, subject, trigger: "APPLICATION_SUBMIT", applicationId, actor: args.actor })
      if (!ran.configured) return
    }
  } catch (error) {
    await logAudit({
      tenantId: args.tenantId,
      userId: args.actor?.id,
      userEmail: args.actor?.email,
      action: AuditAction.SCREENING_RUN_FAILED,
      entity: "applicationId" in target ? "LoanApplication" : "AssetFinanceDeal",
      entityId: "applicationId" in target ? target.applicationId : target.dealId,
      newValue: { trigger: "APPLICATION_SUBMIT", error: error instanceof Error ? error.message : String(error) },
    })
  }
}
