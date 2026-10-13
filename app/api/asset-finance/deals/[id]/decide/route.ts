import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { decideDeal, parseDecideInput } from "@/lib/asset-finance/deal-decision"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * The credit decision on a SUBMITTED or REFERRED deal (decide_asset_finance;
 * lib/asset-finance/deal-decision.ts). Body:
 * `{ decision: "APPROVE" | "DECLINE" | "REFER", reasons: string[] }` — at
 * least one reason, each at least 5 characters, for every decision.
 *
 * APPROVE needs a credit memo. NCA deals additionally need a recorded,
 * affordable s81 assessment and reckless-lending note; the database repeats
 * that gate. A pending NON_NCA override is decided before approval.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const { id } = await params
    const refuse = async (reason: string, status: number, error: string) => {
      await auditRefusal({
        action: AuditAction.ASSET_DEAL_DECISION_REFUSED,
        entity: "AssetFinanceDeal",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status,
      })
      return NextResponse.json({ error }, { status })
    }
    if (!canDo(guard.user.role, "decide_asset_finance")) {
      return refuse("insufficient_role", 403, "Deciding a deal needs the decide_asset_finance permission")
    }
    const input = parseDecideInput(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })

    let result: Awaited<ReturnType<typeof decideDeal>>
    try {
      result = await prisma.$transaction((tx) =>
        decideDeal(tx, { tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, input),
      )
    } catch (error) {
      if (isCheckViolation(error)) {
        return NextResponse.json({ error: "The database refused the decision; the deal changed, try again" }, { status: 409 })
      }
      throw error
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_decidable":
        return NextResponse.json({ error: `A ${result.status} deal cannot be decided` }, { status: 409 })
      case "awaiting_override":
        return refuse("awaiting_regime_approval", 409, "The NON_NCA override awaits a second approver")
      case "memo_required":
        return refuse("credit_memo_required", 409, "Record the credit memo before approving")
      case "assessment_required":
        return refuse("s81_assessment_required", 409, "Record the NCA s81 affordability assessment before approving")
      case "unaffordable":
        return refuse("s81_unaffordable", 409, "The recorded NCA s81 assessment is not affordable")
      case "refused_nca":
        return NextResponse.json({ error: result.reason, deal: await loadDealDetail(tenant.id, id) }, { status: 409 })
      case "decided":
        return NextResponse.json(await loadDealDetail(tenant.id, id))
    }
  })
}
