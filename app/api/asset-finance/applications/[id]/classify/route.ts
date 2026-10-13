import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { classifyApplication } from "@/lib/asset-finance/classification"

/**
 * Classify an entity application as NCA or NON_NCA (DESIGN D5) and snapshot
 * the result on it. No body: the evidence is the entity's own verified
 * documents (financialsEvidenceIds, and its verified Letters of Authority).
 *
 * Any manage_asset_finance user may classify: a NON_NCA result never applies
 * here. The application stays NCA and the response names the PENDING override
 * (`pendingOverrideId`) a different user with decide_asset_finance must approve.
 * `supersededOverrideId` names an open request this run rejected because the
 * classification moved on; `unchanged` is true when a NON_NCA application
 * re-classified to the same rule, and nothing was written.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // manage_asset_finance
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled

    const { id } = await params

    let result: Awaited<ReturnType<typeof classifyApplication>>
    try {
      result = await prisma.$transaction((tx) =>
        classifyApplication(tx, {
          tenantId: tenant.id,
          applicationId: id,
          userId: guard.user.id,
          userEmail: guard.user.email,
        }),
      )
    } catch (error) {
      // The regime triggers re-check under the row lock; a write that lost a
      // race with another decision is a conflict, not a server error.
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The application changed while it was being classified; try again" }, { status: 409 })
      }
      throw error
    }

    const refuse = async (reason: string, status: number, error: string) => {
      await auditRefusal({
        action: AuditAction.NCA_CLASSIFY_REFUSED,
        entity: "LoanApplication",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status,
      })
      return NextResponse.json({ error }, { status })
    }

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      case "not_entity_borrower":
        return refuse(
          "not_entity_borrower",
          422,
          "Only a business-entity application is classified; a natural person is always NCA",
        )
      case "regime_frozen":
        return refuse("regime_frozen", 409, `The NCA regime is frozen once an application is ${result.status}`)
      case "classified":
        return NextResponse.json({
          classification: result.classification,
          previousRegime: result.previousRegime,
          regime: result.regime,
          pendingOverrideId: result.pendingOverrideId,
          supersededOverrideId: result.supersededOverrideId,
          unchanged: result.unchanged,
        })
    }
  })
}
