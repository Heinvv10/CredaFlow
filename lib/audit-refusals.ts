import { logAudit, AuditAction } from "@/lib/audit"

/**
 * Record that a state-changing action was REFUSED.
 *
 * Logging only what a system PERMITS leaves refusals invisible: a refusal path
 * in the disbursement route, or a denied document access, would otherwise write
 * no AuditLog or DocumentAccessLog row at all.
 *
 * The controls hold either way — nothing leaks, no money moves. The gap is
 * DETECTIVE, not preventive: an auditor asking "did anyone attempt to pay out
 * against unverified identity, or enumerate documents across a tenant
 * boundary?" gets silence. For a regulated lender the refused attempts are
 * frequently the exact thing a regulator asks for, and a POPIA access register
 * that omits denials cannot answer a DSAR about them.
 *
 * Called from the response seam rather than at each refusal site, so a refusal
 * added later is covered without anyone remembering to log it.
 *
 * MUST be called OUTSIDE any transaction the refusal itself aborts. Several of
 * the disbursement refusals throw inside prisma.$transaction; a row queued in
 * there is rolled back by the very throw that refuses the action.
 */
export async function auditRefusal(params: {
  action: (typeof AuditAction)[keyof typeof AuditAction]
  entity: string
  entityId: string
  userId?: string | null
  userEmail?: string | null
  tenantId?: string | null
  /** Machine-readable cause — the precondition or denial reason. */
  reason: string
  status: number
  detail?: Record<string, unknown>
}): Promise<void> {
  await logAudit({
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    userId: params.userId ?? undefined,
    userEmail: params.userEmail ?? undefined,
    tenantId: params.tenantId ?? undefined,
    newValue: {
      refused: true,
      reason: params.reason,
      httpStatus: params.status,
      ...(params.detail ?? {}),
    },
  })
}

/**
 * Pull the refusal cause out of a response this route already built.
 *
 * Returns null for anything that is not a refusal, so the seam is a no-op on
 * the success path. Reads a CLONE — consuming the body would empty the response
 * the caller is about to return.
 */
export async function refusalReasonFrom(
  response: Response,
  field: string,
): Promise<{ reason: string; status: number } | null> {
  if (response.status < 400) return null
  try {
    const body = (await response.clone().json()) as Record<string, unknown>
    const reason = body?.[field]
    if (typeof reason === "string" && reason.length > 0) {
      return { reason, status: response.status }
    }
    // Keying ONLY on the marker meant a refusal that happened not to carry it
    // — the preflight AVS 409, the accepted-PASQ fingerprint 422 — wrote no
    // row at all. A seam that depends on every future refusal remembering to
    // set a field is the same fragility as logging at each call site.
    //
    // Fall back to the status, but for 4xx ONLY. A 5xx is a CRASH, not a
    // decision: logging it here would file server failures as compliance
    // refusals and pollute the very trail this exists to make trustworthy.
    // (This boundary is load-bearing — an existing test pins it.)
    if (response.status >= 500) return null
    return { reason: `unlabelled_${response.status}`, status: response.status }
  } catch {
    // A non-JSON body (a redirect, a stream) is not a structured refusal.
    return null
  }
}

/**
 * Record a refused attempt to reach a client document.
 *
 * Deliberately resolves the actor itself. The caller is authenticated, but
 * when it resolves to no Client row in the tenant getDocumentCaller returns
 * null and the route answers 401 with the caller's identity already
 * discarded. (A caller bound to a DIFFERENT tenant now resolves as a caller and
 * is refused 403 by withTenantContext; withTenantContextLoggingRefusal in
 * lib/documents/tenant-refusal.ts logs that case.) Logging "someone was
 * refused" without saying who is barely worth the row, so this reads the
 * session directly.
 *
 * Never throws: a refusal must still be refused if the audit write fails.
 */
export async function auditDocumentAccessRefusal(params: {
  documentId: string
  reason: string
  status: number
  tenantId?: string | null
  actorEmail?: string | null
  /** Staff id when the caller is staff — an email alone loses the actor key. */
  actorUserId?: string | null
  /** Used only to resolve the tenant when one is not already in scope. */
  req?: Request
  detail?: Record<string, unknown>
}): Promise<void> {
  let email = params.actorEmail ?? null
  if (!email) {
    try {
      const { auth } = await import("@/lib/auth")
      const session = await auth()
      email = session?.user?.email ?? null
    } catch {
      email = null
    }
  }
  // Resolve a tenant rather than trusting the call site to pass one. The first
  // version of this took `tenantId` as an optional argument, and the callers
  // that had no tenant in scope simply omitted it — so the rows persisted with
  // a null tenant and were invisible to the audit page and the compliance
  // export, both of which filter by an exact tenant id. A row nobody can
  // retrieve is not a record. Making it the helper's job removes the choice.
  let tenantId = params.tenantId ?? null
  if (!tenantId && params.req) {
    try {
      // The REQUEST's tenant, resolved the same way withTenantContext resolves
      // it (host -> custom domain -> slug). Falling back to
      // getDefaultTenantId() is worse than a null: on a cross-tenant
      // probe it files the refusal against the DEFAULT tenant, so the row is
      // not merely missing from the right register, it is planted in the wrong
      // one. A refusal attributed to the wrong tenant is a false record.
      const { getTenantFromRequest } = await import("@/lib/tenant")
      tenantId = (await getTenantFromRequest(params.req))?.id ?? null
    } catch {
      tenantId = null
    }
  }
  await auditRefusal({
    action: AuditAction.DOCUMENT_ACCESS_REFUSED,
    entity: "ClientDocument",
    entityId: params.documentId,
    tenantId,
    userId: params.actorUserId ?? undefined,
    userEmail: email,
    reason: params.reason,
    status: params.status,
    detail: params.detail,
  })
}
