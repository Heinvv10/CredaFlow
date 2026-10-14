import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { canDo, requireApiRole, type PermissionKey, type StaffUser } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { LenderIdentityError } from "@/lib/config/identity"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { NoVatRateError } from "@/lib/vat/vat-rate"
import { VatNotConfiguredError } from "@/lib/vat/tax-invoice"
import { requireAssetFinanceEnabled } from "./require-enabled"
import { BookingAmountError } from "./booking-plan"
import { BookingRaceError } from "./booking"

// The gate every payout-gate route passes (goal §4.10), in the order the
// other asset-finance routes use: a staff session, the session bound to the
// request's tenant, the tenant's flag, then the permission — refused with an
// audited 403. Refusals are ASSET_PAYOUT_REFUSED rows.

export interface PayoutStaffContext {
  tenantId: string
  user: StaffUser
  /** Audit the refusal (outside any transaction) and answer it. */
  refuse: (reason: string, status: number, error: string, detail?: Record<string, unknown>) => Promise<NextResponse>
}

export async function withPayoutStaff(
  req: Request,
  opts: { dealId: string; permission: PermissionKey | null },
  handler: (ctx: PayoutStaffContext) => Promise<Response>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const user = guard.user

  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const refuse: PayoutStaffContext["refuse"] = async (reason, status, error, detail) => {
      await auditRefusal({
        action: AuditAction.ASSET_PAYOUT_REFUSED,
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
    if (opts.permission && !canDo(user.role, opts.permission)) {
      return refuse("insufficient_role", 403, `This step needs the ${opts.permission} permission`)
    }
    try {
      return await handler({ tenantId: tenant.id, user, refuse })
    } catch (error) {
      const mapped = payoutErrorResponse(error)
      if (mapped) return refuse(mapped.reason, mapped.status, mapped.error)
      throw error
    }
  })
}

/** The refusal for an error that means "this cannot be done now"; null for anything else. */
export function payoutErrorResponse(error: unknown): { reason: string; status: number; error: string } | null {
  if (error instanceof LenderIdentityError) return { reason: "lender_identity", status: 422, error: error.message }
  if (error instanceof VatNotConfiguredError) {
    return { reason: "vat_not_configured", status: 422, error: "Record the lender's VAT vendor details first: booking issues a tax invoice" }
  }
  if (error instanceof NoVatRateError) return { reason: "no_vat_rate", status: 422, error: error.message }
  if (error instanceof BookingAmountError) return { reason: "amount_too_large", status: 422, error: error.message }
  if (error instanceof BookingRaceError) return { reason: "race", status: 409, error: error.message }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return { reason: "race", status: 409, error: "The deal changed while this ran; nothing was written. Reload and try again" }
  }
  if (isCheckViolation(error)) {
    return { reason: "database_guard", status: 409, error: "The database refused this step; the deal, checklist or payout changed. Reload and try again" }
  }
  return null
}
