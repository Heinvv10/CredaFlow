import { NextRequest } from "next/server"
import { leasePortalAction } from "@/lib/asset-finance/lease-route"
import { quoteEarlyTermination } from "@/lib/asset-finance/lease-termination-store"

type Params = { params: Promise<{ loanId: string }> }

/** The lessee asks for an early-termination quote (a CPA lessee's is on 20 business days' notice). */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leasePortalAction(req, loanId, "portal_termination_quote", (tx, actor, today) => quoteEarlyTermination(tx, actor, { loanId, today }))
}
