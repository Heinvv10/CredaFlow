import { NextRequest } from "next/server"
import { leaseStaffAction } from "@/lib/asset-finance/lease-route"
import { acceptEarlyTermination } from "@/lib/asset-finance/lease-termination-store"

type Params = { params: Promise<{ loanId: string; quoteId: string }> }

/** Accept an early-termination quote on the lessee's instruction (decide_asset_finance): rentals cancelled, the amount invoiced, the return opened. */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, quoteId } = await params
  return leaseStaffAction(req, { loanId, permission: "decide_asset_finance", action: "termination_accept" }, async (tx, actor, today, body) => {
    const quote = await tx.leaseTerminationQuote.findFirst({ where: { id: quoteId, tenantId: actor.tenantId, loanId }, select: { id: true } })
    if (!quote) return { kind: "not_found" }
    return acceptEarlyTermination(tx, { tenantId: actor.tenantId, userId: actor.userId }, { quoteId, today, assessment: body.assessment as Parameters<typeof acceptEarlyTermination>[2]["assessment"] })
  })
}
