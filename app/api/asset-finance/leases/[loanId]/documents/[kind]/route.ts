import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireAssetFinanceEnabled } from "@/lib/asset-finance/require-enabled"
import { isLeaseDocumentKind, leaseDocumentTarget, serveLeaseDocument } from "@/lib/asset-finance/documents/lease/lease-docs-serve"

type Params = { params: Promise<{ loanId: string; kind: string }> }

const notFound = (error = "Not found") => NextResponse.json({ error }, { status: 404 })

/**
 * A lease's servicing document as a PDF, for staff (READONLY and above): kind
 * is `expiry-notice`, `termination-quote` (`?quoteId=`) or `inspection-report`;
 * `?download=1` serves an attachment. The loan must be one of the tenant's
 * leases and the row must exist (404). The read is logged in DocumentAccessLog
 * before rendering (lib/asset-finance/documents/lease/lease-docs-serve.ts).
 * Every 403 or 404 (role, tenant, module off, unknown kind, not a lease, no
 * such row) is audited as DOCUMENT_ACCESS_REFUSED, as the portal route's are.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, kind } = await params
  const guard = await requireApiRole("READONLY")
  if (guard.error) {
    if (guard.error.status === 403) {
      const user = (await auth())?.user
      await refused(loanId, kind, { tenantId: user?.tenantId, userId: user?.id, email: user?.email }, "staff_role_refused", 403)
    }
    return guard.error
  }
  const { user } = guard
  let reason = "tenant_scope_refused" // withTenantContext refuses before the handler runs
  const outcome = await withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) {
      reason = "module_disabled"
      return disabled
    }
    if (!isLeaseDocumentKind(kind)) {
      reason = "unknown_document_kind"
      return notFound()
    }
    const lease = await prisma.loan.findFirst({ where: { id: loanId, tenantId: tenant.id, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } }, select: { id: true } })
    if (!lease) {
      reason = "lease_not_found"
      return notFound("Lease not found")
    }
    reason = "document_not_found"
    return serveLeaseDocument(prisma, req, { tenantId: tenant.id, loanId, kind }, { type: "staff", id: user.id })
  })
  if (outcome.status === 403 || outcome.status === 404) {
    await refused(loanId, kind, { tenantId: user.tenantId, userId: user.id, email: user.email }, reason, outcome.status)
  }
  return outcome
}

async function refused(
  loanId: string,
  kind: string,
  actor: { tenantId?: string | null; userId?: string | null; email?: string | null },
  reason: string,
  status: number,
): Promise<void> {
  await auditRefusal({
    action: AuditAction.DOCUMENT_ACCESS_REFUSED,
    ...leaseDocumentTarget(loanId),
    tenantId: actor.tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    reason,
    status,
    detail: { accessorType: "staff", accessorId: actor.userId ?? null, loanId, kind },
  })
}
