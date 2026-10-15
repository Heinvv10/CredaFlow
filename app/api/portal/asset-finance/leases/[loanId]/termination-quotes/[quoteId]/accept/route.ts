import { NextRequest } from "next/server"
import { leasePortalAction } from "@/lib/asset-finance/lease-route"
import { acceptEarlyTermination } from "@/lib/asset-finance/lease-termination-store"

type Params = { params: Promise<{ loanId: string; quoteId: string }> }

/** The lessee accepts their early-termination quote while it is valid. */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId, quoteId } = await params
  return leasePortalAction(req, loanId, "portal_termination_accept", async (tx, actor, today) => {
    const quote = await tx.leaseTerminationQuote.findFirst({ where: { id: quoteId, tenantId: actor.tenantId, loanId }, select: { id: true } })
    if (!quote) return { kind: "not_found" }
    return acceptEarlyTermination(tx, actor, { quoteId, today })
  })
}
