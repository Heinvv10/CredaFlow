import { AuditAction } from "@/lib/audit"
import { auditDocumentAccessRefusal, auditRefusal } from "@/lib/audit-refusals"
import type { CallerInfo } from "@/lib/document-auth"
import { getTenantFromRequest, withTenantContext, type TenantContext } from "@/lib/tenant"

/**
 * withTenantContext for the document routes, with the wrapper's own refusals
 * logged to the POPIA access register.
 *
 * A caller bound to another tenant (a tenant-B portal client or staff user on
 * tenant A's host) is authenticated and resolves as a caller, so
 * getDocumentCaller no longer returns null for them; withTenantContext then
 * answers 403 BEFORE the handler runs, and no route-level check ever sees it.
 * Without this the cross-tenant probe leaves no trace.
 *
 * Cross-tenant refusals are split per tenant (see auditWrapperRefusal).
 *
 * Only refusals the wrapper produced are logged here (the handler never ran).
 * A 4xx the handler returned was either logged at its own refusal site or is
 * not an access refusal, so logging it here would double-count. 5xx is a
 * crash, not a decision.
 */
export async function withTenantContextLoggingRefusal<T>(
  req: Request,
  scope: { documentId: string; caller: CallerInfo },
  handler: (tenant: TenantContext) => Promise<T>,
): Promise<T | Response> {
  let handlerRan = false
  const outcome = await withTenantContext(req, (tenant) => {
    handlerRan = true
    return handler(tenant)
  })
  if (!handlerRan && outcome instanceof Response && outcome.status >= 400 && outcome.status < 500) {
    await auditWrapperRefusal({ req, documentId: scope.documentId, caller: scope.caller, status: outcome.status })
  }
  return outcome
}

/**
 * Record a refusal withTenantContext produced before the handler ran.
 *
 * When the session belongs to a DIFFERENT tenant than the host resolved, each
 * lender is its own POPIA responsible party, so the two registers are kept
 * apart:
 *  - the probed tenant's row records the probe (document id, reason, status)
 *    with NO actor identity;
 *  - the actor's own tenant gets an attributed row with NO identifier of the
 *    probed tenant (no document id, no tenant id, no host).
 * Otherwise (same tenant, or one side unresolved) the actor is attributed in
 * the request tenant, as before.
 */
export async function auditWrapperRefusal(params: {
  req: Request
  documentId: string
  caller: CallerInfo
  status: number
}): Promise<void> {
  const { req, documentId, caller, status } = params
  const reason = status === 403 ? "tenant_scope_refused" : `unlabelled_${status}`

  let requestTenantId: string | null = null
  let sessionTenantId: string | null = null
  let sessionEmail: string | null = null
  try {
    requestTenantId = (await getTenantFromRequest(req))?.id ?? null
    const { auth } = await import("@/lib/auth")
    const session = await auth()
    sessionTenantId = session?.user?.tenantId ?? null
    sessionEmail = session?.user?.email ?? null
  } catch {
    // Resolution failure falls through to the same-tenant path below, which
    // never files the actor under a tenant it was not matched to.
  }

  // No tenant for the request (the wrapper's 400 "Tenant not found"): a row
  // would carry a null tenant, which no audit page or export can retrieve.
  if (!requestTenantId) return

  if (requestTenantId && sessionTenantId && requestTenantId !== sessionTenantId) {
    await auditDocumentAccessRefusal({
      documentId,
      reason,
      status,
      tenantId: requestTenantId,
      anonymous: true,
    })
    const actorId = caller.type === "client" ? caller.clientId : caller.userId
    await auditRefusal({
      action: AuditAction.DOCUMENT_ACCESS_REFUSED,
      entity: caller.type === "client" ? "Client" : "User",
      entityId: actorId,
      tenantId: sessionTenantId,
      userId: caller.type === "staff" ? caller.userId : undefined,
      userEmail: caller.type === "client" ? caller.email : sessionEmail,
      reason: "cross_tenant_access_attempt",
      status,
    })
    return
  }

  await auditDocumentAccessRefusal({
    documentId,
    reason,
    status,
    actorEmail: caller.type === "client" ? caller.email : undefined,
    actorUserId: caller.type === "staff" ? caller.userId : undefined,
    req,
  })
}
