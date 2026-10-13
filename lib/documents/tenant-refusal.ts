import { auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import type { CallerInfo } from "@/lib/document-auth"
import { withTenantContext, type TenantContext } from "@/lib/tenant"

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
    await auditDocumentAccessRefusal({
      documentId: scope.documentId,
      reason: outcome.status === 403 ? "tenant_scope_refused" : `unlabelled_${outcome.status}`,
      status: outcome.status,
      actorEmail: scope.caller.type === "client" ? scope.caller.email : undefined,
      actorUserId: scope.caller.type === "staff" ? scope.caller.userId : undefined,
      req,
    })
  }
  return outcome
}
