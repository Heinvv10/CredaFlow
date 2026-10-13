import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { isTransactionConflict } from "@/lib/asset-finance/transaction-conflict"
import { classifyApplication } from "@/lib/asset-finance/classification"

const MAX_EVIDENCE_IDS = 50

function parseTrusteeEvidenceIds(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const value = (body as { trusteeEvidenceIds?: unknown }).trusteeEvidenceIds
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return null
    ids.push(item.trim())
  }
  return [...new Set(ids)]
}

/**
 * Classify an entity application as NCA or NON_NCA (DESIGN D5) and snapshot
 * the result on it. Body: `{ trusteeEvidenceIds?: string[] }`.
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
    const body: unknown = await req.json().catch(() => ({}))
    const trusteeEvidenceIds = parseTrusteeEvidenceIds(body)
    if (!trusteeEvidenceIds) {
      return NextResponse.json(
        { error: `trusteeEvidenceIds must be an array of at most ${MAX_EVIDENCE_IDS} non-empty strings` },
        { status: 400 },
      )
    }

    let result: Awaited<ReturnType<typeof classifyApplication>>
    try {
      result = await prisma.$transaction((tx) =>
        classifyApplication(tx, {
          tenantId: tenant.id,
          applicationId: id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          trusteeEvidenceIds,
        }),
      )
    } catch (error) {
      // A deadlock or serialization failure (40P01 / 40001) rolled everything
      // back: the same request can be retried.
      if (isTransactionConflict(error)) {
        return NextResponse.json({ error: "Another change to this application was in progress; try again" }, { status: 409 })
      }
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
