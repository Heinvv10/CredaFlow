import { NextRequest, NextResponse } from "next/server"
import { withPortalLoan, portalLoanNotFound } from "@/lib/asset-finance/portal-loan-route"
import { loadPortalContract } from "@/lib/asset-finance/portal-contract"

type Params = { params: Promise<{ loanId: string }> }

/**
 * One booked asset-finance contract for a client with authority over its
 * entity: summary, balance, arrears, next payment, schedule, tax invoice and
 * the deal documents the client may read (read-only).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withPortalLoan(req, loanId, async ({ tenantId, client, entityId }) => {
    const view = await loadPortalContract(tenantId, entityId, loanId, client.clientId)
    return view ? NextResponse.json(view) : portalLoanNotFound()
  })
}
