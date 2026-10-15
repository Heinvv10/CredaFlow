import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { getPortalClient, withPortalEntity, type PortalClient } from "./portal-route"
import { requirePortalEntityAccess } from "./portal-access"

// The gate every portal route keyed by a LEASE loan passes (slice 3, C10): the
// portal-entity gate (CLIENT session 401, tenant 403, flag 404), then the loan
// must be an operating or full-maintenance lease of the session's tenant, and
// the client must either hold an authorising role in its entity (an entity
// lessee, as ./portal-loan-route.ts) or be the lessee themselves (a sole
// proprietor). Any other loan, tenant or client gets the same 404.

export interface PortalLeaseContext {
  tenantId: string
  client: PortalClient
  loanId: string
  entityId: string | null
}

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 })

/** The lease loan the client may act on, or null. */
export async function findPortalLease(tenantId: string, clientId: string, loanId: string): Promise<{ entityId: string | null } | null> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, tenantId, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
    select: { entityId: true, clientId: true },
  })
  if (!loan) return null
  if (loan.entityId === null) return loan.clientId === clientId ? { entityId: null } : null
  return (await requirePortalEntityAccess(tenantId, clientId, loan.entityId)) === null ? { entityId: loan.entityId } : null
}

export async function withPortalLease(
  req: Request,
  loanId: string,
  handler: (ctx: PortalLeaseContext) => Promise<Response>,
): Promise<Response> {
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const lease = await findPortalLease(tenantId, client.clientId, loanId)
    if (!lease) return notFound()
    return handler({ tenantId, client, loanId, entityId: lease.entityId })
  })
}

/** withPortalLease for a route serving a document: a 403 or 404 is audited as DOCUMENT_ACCESS_REFUSED. */
export async function withPortalLeaseDocument(
  req: Request,
  loanId: string,
  target: { entity: string; entityId: string },
  handler: (ctx: PortalLeaseContext) => Promise<Response>,
): Promise<Response> {
  const outcome = await withPortalLease(req, loanId, handler)
  if (outcome.status === 403 || outcome.status === 404) {
    const client = await getPortalClient()
    await auditRefusal({
      action: AuditAction.DOCUMENT_ACCESS_REFUSED,
      entity: target.entity,
      entityId: target.entityId,
      tenantId: client?.tenantId,
      userEmail: client?.email,
      reason: outcome.status === 403 ? "tenant_scope_refused" : "not_authorised_for_lease_or_not_found",
      status: outcome.status,
      detail: { accessorType: "client", accessorId: client?.clientId ?? null, loanId },
    })
  }
  return outcome
}

export { notFound as portalLeaseNotFound }
