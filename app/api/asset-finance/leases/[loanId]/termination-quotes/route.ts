import { NextRequest } from "next/server"
import { leaseStaffAction } from "@/lib/asset-finance/lease-route"
import { quoteEarlyTermination } from "@/lib/asset-finance/lease-termination-store"

type Params = { params: Promise<{ loanId: string }> }

/** Quote the early termination of a lease (manage_asset_finance; lib/asset-finance/lease-termination-store.ts). */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leaseStaffAction(req, { loanId, permission: "manage_asset_finance", action: "termination_quote" }, (tx, actor, today) =>
    quoteEarlyTermination(tx, { tenantId: actor.tenantId, userId: actor.userId }, { loanId, today }))
}
