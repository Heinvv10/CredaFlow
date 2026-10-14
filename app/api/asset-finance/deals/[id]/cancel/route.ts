import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { CancelRaceError, cancelDeal, parseCancelInput } from "@/lib/asset-finance/deal-cancel"
import { loadDealDetail } from "@/lib/asset-finance/deal-detail"

/**
 * Cancels a deal that is not yet booked (decide_asset_finance;
 * lib/asset-finance/deal-cancel.ts): an unreleased payout, the deal and its
 * application are CANCELLED and the asset released, audited. Body:
 * `{ reason }`, at least 10 characters. 409 (audited) for a BOOKED, DECLINED,
 * REFUSED_NCA or already CANCELLED deal, or when the deal changed meanwhile;
 * 403 (audited) without the permission.
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
        action: AuditAction.ASSET_DEAL_CANCEL_REFUSED,
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
      return refuse("insufficient_role", 403, "Cancelling a deal needs the decide_asset_finance permission")
    }
    const input = parseCancelInput(await req.json().catch(() => null))
    if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })

    let result: Awaited<ReturnType<typeof cancelDeal>>
    try {
      result = await cancelDeal({ tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email }, id, input.reason)
    } catch (error) {
      const raced = error instanceof CancelRaceError
        || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")
        || isCheckViolation(error)
      if (raced) return refuse("race", 409, "The deal changed while it was being cancelled; nothing was cancelled. Reload and try again")
      throw error
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Deal not found" }, { status: 404 })
      case "not_cancellable":
        return refuse("not_cancellable", 409, `A ${result.status} deal cannot be cancelled`)
      case "cancelled":
        return NextResponse.json(await loadDealDetail(tenant.id, id))
    }
  })
}
