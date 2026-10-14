import { NextResponse } from "next/server"
import { canDo, requireApiRole, type StaffUser } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { LenderIdentityError } from "@/lib/config/identity"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { requireAssetFinanceEnabled } from "./require-enabled"
import { DealDocumentError } from "./documents/deal-document-data"
import { SignerChangedError } from "./signing-wet-ink"

// The gate every staff deal-signing route passes, in the order the other
// asset-finance routes use: a staff session (requireApiRole), the session
// bound to the request's tenant (withTenantContext), the tenant's flag, then
// manage_asset_finance for writes — refused with an audited 403. Reads need
// any staff role. Errors that mean "this cannot be signed" map to 409 / 422.

export interface SigningStaffContext {
  tenantId: string
  user: StaffUser
  /** Audit the refusal (outside any transaction) and answer it. */
  refuse: (reason: string, status: number, error: string, detail?: Record<string, unknown>) => Promise<NextResponse>
}

export async function withSigningStaff(
  req: Request,
  opts: { dealId: string; manage: boolean },
  handler: (ctx: SigningStaffContext) => Promise<Response>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const user = guard.user

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const refuse: SigningStaffContext["refuse"] = async (reason, status, error, detail) => {
      await auditRefusal({
        action: AuditAction.ASSET_DEAL_SIGNING_REFUSED,
        entity: "AssetFinanceDeal",
        entityId: opts.dealId,
        tenantId: tenant.id,
        userId: user.id,
        userEmail: user.email,
        reason,
        status,
        detail,
      })
      return NextResponse.json({ error, ...(detail ?? {}) }, { status })
    }
    if (opts.manage && !canDo(user.role, "manage_asset_finance")) {
      return refuse("insufficient_role", 403, "Deal signing needs the manage_asset_finance permission")
    }
    try {
      return await handler({ tenantId: tenant.id, user, refuse })
    } catch (error) {
      const mapped = signingErrorResponse(error)
      if (mapped) return mapped
      throw error
    }
  })
}

/** The answer for an error that means the documents cannot be rendered or the row changed; null otherwise. */
export function signingErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof LenderIdentityError) {
    return NextResponse.json({ error: error.message, fields: error.fields }, { status: 422 })
  }
  if (error instanceof DealDocumentError) return NextResponse.json({ error: error.message }, { status: 422 })
  if (error instanceof SignerChangedError) return NextResponse.json({ error: error.message }, { status: 409 })
  if (isCheckViolation(error)) {
    return NextResponse.json({ error: "The database refused this signing step; reload the deal and try again" }, { status: 409 })
  }
  return null
}
