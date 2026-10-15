import { NextRequest, NextResponse } from "next/server"
import { badRequest, leaseStaffAction, text } from "@/lib/asset-finance/lease-route"
import { approveMaintenanceClaim, markMaintenanceClaimPaid, rejectMaintenanceClaim } from "@/lib/asset-finance/maintenance-claims"

type Params = { params: Promise<{ loanId: string; claimId: string; action: string }> }

/**
 * Decide a maintenance claim (decide_asset_finance): `approve` (four-eyes: a
 * second, different approver at or above the tenant threshold), `reject`
 * (`{ reason }`), `paid` (`{ paymentReference }`; the money moves outside
 * CredaFlow). The claim must be of this lease.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, claimId, action } = await params
  if (!["approve", "reject", "paid"].includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 404 })
  return leaseStaffAction(req, { loanId, permission: "decide_asset_finance", action: `claim_${action}` }, async (tx, actor, today, body) => {
    const claim = await tx.maintenanceClaim.findFirst({ where: { id: claimId, tenantId: actor.tenantId, fund: { loanId } }, select: { id: true } })
    if (!claim) return { kind: "not_found" }
    if (action === "approve") return approveMaintenanceClaim(tx, actor, claimId)
    if (action === "reject") {
      const reason = text(body, "reason")
      return reason ? rejectMaintenanceClaim(tx, actor, claimId, reason) : badRequest("reason", "Give the reason")
    }
    const reference = text(body, "paymentReference")
    return reference ? markMaintenanceClaimPaid(tx, actor, claimId, reference, today) : badRequest("paymentReference", "Record the payment reference")
  })
}
