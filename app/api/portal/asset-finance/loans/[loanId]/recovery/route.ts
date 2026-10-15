import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { clientRecoveryAccess, loadPortalRecoveryView } from "@/lib/asset-finance/recovery-view"

/** The consumer's view of a recovery on their contract: status, notices and the final account with its cost lines. Never the buyer. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ loanId: string }> }) {
  const { loanId } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    if (!(await clientRecoveryAccess(tenantId, client.clientId, loanId))) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ recovery: await loadPortalRecoveryView(tenantId, loanId) })
  })
}
