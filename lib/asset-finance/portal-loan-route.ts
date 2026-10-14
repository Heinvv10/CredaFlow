import { NextResponse } from "next/server"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { getPortalClient, withPortalEntity, type PortalClient } from "./portal-route"
import { requirePortalEntityAccess } from "./portal-access"
import { findPortalLoanEntity } from "./portal-contract"

// The gate every portal route keyed by an asset-finance loan passes: the
// portal-entity gate (CLIENT session 401, tenant 403, flag 404), then the
// loan must be an entity-borrower loan of the session's tenant, and the client
// must hold an authorising role in THAT loan's entity
// (lib/asset-finance/portal-access.ts). A consumer loan, another tenant's
// loan, another entity's loan and a SURETY-only client all get the same 404.

export interface PortalLoanContext {
  tenantId: string
  client: PortalClient
  loanId: string
  entityId: string
}

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 })

export async function withPortalLoan(
  req: Request,
  loanId: string,
  handler: (ctx: PortalLoanContext) => Promise<Response>,
): Promise<Response> {
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const entityId = await findPortalLoanEntity(tenantId, loanId)
    if (!entityId) return notFound()
    const denied = await requirePortalEntityAccess(tenantId, client.clientId, entityId)
    if (denied) return denied
    return handler({ tenantId, client, loanId, entityId })
  })
}

/**
 * withPortalLoan for a route that serves a document's bytes: a 403 or 404 is
 * audited as DOCUMENT_ACCESS_REFUSED, so probing for other entities'
 * statements, invoices or agreements leaves a trace.
 */
export async function withPortalLoanDocument(
  req: Request,
  loanId: string,
  target: { entity: string; entityId: string },
  handler: (ctx: PortalLoanContext) => Promise<Response>,
): Promise<Response> {
  const outcome = await withPortalLoan(req, loanId, handler)
  if (outcome.status === 403 || outcome.status === 404) {
    const client = await getPortalClient()
    await auditRefusal({
      action: AuditAction.DOCUMENT_ACCESS_REFUSED,
      entity: target.entity,
      entityId: target.entityId,
      tenantId: client?.tenantId,
      userEmail: client?.email,
      reason: outcome.status === 403 ? "tenant_scope_refused" : "not_authorised_for_loan_or_not_found",
      status: outcome.status,
      detail: { accessorType: "client", accessorId: client?.clientId ?? null, loanId },
    })
  }
  return outcome
}

export { notFound as portalLoanNotFound }
