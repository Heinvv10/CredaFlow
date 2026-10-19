import { NextRequest, NextResponse } from "next/server"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { approvePayableRun } from "@/lib/dealer/payable-runs"
import { refusalResponse, withDealerStaff } from "@/lib/dealer/staff-route"

/** Approves a pending payable run (decide_asset_finance); never its creator (403, audited; also CHECK DealerPayableRun_four_eyes). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  return withDealerStaff(req, "decide_asset_finance", async ({ tenantId, staff }) => {
    const { runId } = await params
    const result = await approvePayableRun(staff, runId)
    if (result.kind === "refused") return refusalResponse(result)
    if (result.kind === "self_approval") {
      await auditRefusal({
        action: AuditAction.DEALER_PAYABLE_RUN_APPROVAL_REFUSED, entity: "DealerPayableRun", entityId: runId,
        tenantId, userId: staff.userId, userEmail: staff.userEmail, reason: "four_eyes_self_approval", status: 403,
      })
      return NextResponse.json({ error: "A payable run must be approved by someone other than its creator" }, { status: 403 })
    }
    return NextResponse.json(result)
  })
}
