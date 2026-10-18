import { NextRequest } from "next/server"
import { leaseStaffAction } from "@/lib/asset-finance/lease-route"
import { recordLeaseTotalLoss } from "@/lib/asset-finance/lease-total-loss"

export async function POST(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params
  return leaseStaffAction(req, { loanId, permission: "decide_asset_finance", action: "total_loss" }, (tx, actor, today, body) =>
    recordLeaseTotalLoss(tx, actor, { loanId, today, lossOn: body.lossOn as string | undefined, insuranceReceivedOn: body.insuranceReceivedOn as string | undefined, insuranceProceedsCents: body.insuranceProceedsCents as number, evidence: body.evidence as string }))
}
