import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { isLeaseDocumentKind, serveLeaseDocument } from "@/lib/asset-finance/documents/lease/lease-docs-serve"

type Params = { params: Promise<{ loanId: string; kind: string }> }

/**
 * A lease's servicing document as a PDF, for staff (READONLY and above): kind
 * is `expiry-notice`, `termination-quote` (`?quoteId=`) or `inspection-report`;
 * `?download=1` serves an attachment. The loan must be one of the tenant's
 * leases and the row must exist (404). The read is logged in DocumentAccessLog
 * before rendering (lib/asset-finance/documents/lease/lease-docs-serve.ts).
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, kind } = await params
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { user } = guard
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    if (!isLeaseDocumentKind(kind)) return NextResponse.json({ error: "Not found" }, { status: 404 })
    const lease = await prisma.loan.findFirst({ where: { id: loanId, tenantId: tenant.id, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } }, select: { id: true } })
    if (!lease) return NextResponse.json({ error: "Lease not found" }, { status: 404 })
    return serveLeaseDocument(prisma, req, { tenantId: tenant.id, loanId, kind }, { type: "staff", id: user.id })
  })
}
