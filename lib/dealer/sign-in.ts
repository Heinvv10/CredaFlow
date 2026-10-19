/**
 * Dealer user sign-in (lib/auth.ts authorize() calls this for loginType
 * "dealer", which it accepts only on DEALER_APP_HOST and refuses everywhere
 * else; the rate buckets have already run).
 *
 * Order: the lender from the host → the dealer user (tenantId, email) → bcrypt
 * always (a dummy comparison when there is no row or no password, so timing
 * does not tell them apart) → dealerPrincipalRefusal (the rules every request
 * re-applies, lib/dealer/principal.ts) → dealerSecondFactor → lastLoginAt and
 * the DEALER_SIGNED_IN audit row. LoginLog.userId is a User FK, so dealer
 * sign-ins are audited instead of logged there.
 *
 * Every refusal looks the same to the caller ("Invalid email or password").
 */
import bcrypt from "bcryptjs"
import type { DealerRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { getTenantFromRequest } from "@/lib/tenant"
import { AuditAction, logAudit } from "@/lib/audit"
import { dealerAuditFields } from "./actor"
import { dealerPrincipalRefusal, dealerRefusalReason, loadDealerPrincipal, type DealerPrincipalRow } from "./principal"

export type DealerSignInUser = {
  id: string
  email: string
  name: string
  role: "DEALER"
  tenantId: string
  dealerId: string
  dealerRole: DealerRole
  tokenVersion: number
  totpVerified: false
  totpEnrolmentRequired: false
}

export type DealerSignInResult = { ok: true; user: DealerSignInUser } | { ok: false; error: "refused" }

/**
 * The second-factor seam. Dealer users are password-only in this slice, so the
 * portal is demo-only (TenantConfig_dealer_portal_demo_only). Dealer 2FA
 * replaces this with the TOTP outcome (cf. lib/auth-totp-step.ts) and that
 * CHECK; until then every user is "not_enrolled".
 */
export type DealerSecondFactor = { kind: "not_enrolled" } | { kind: "required" } | { kind: "invalid" } | { kind: "verified" }

export async function dealerSecondFactor(_user: Pick<DealerPrincipalRow, "id">, _code: unknown): Promise<DealerSecondFactor> {
  return { kind: "not_enrolled" }
}

export async function authorizeDealer(input: {
  email: string
  password: string
  code: unknown
  request: Request
  /** Records a FailedLoginAttempt row (lib/auth.ts). */
  recordFailure: (reason: string) => Promise<unknown>
  /** Burns the bcrypt time of a real comparison when there is nothing to compare with. */
  equalizeTiming: (candidate: string) => Promise<void>
}): Promise<DealerSignInResult> {
  const { email, password, recordFailure } = input
  const refused = { ok: false as const, error: "refused" as const }
  const tenant = await getTenantFromRequest(input.request)
  const row = tenant ? await loadDealerPrincipal({ tenantId: tenant.id, email }) : null
  if (!row?.passwordHash) {
    await input.equalizeTiming(password)
    await recordFailure(row ? dealerRefusalReason("password_unset") : "dealer_wrong_password")
    return refused
  }
  const passwordMatch = await bcrypt.compare(password, row.passwordHash)
  const refusal = dealerPrincipalRefusal(row)
  if (!passwordMatch || refusal) {
    await recordFailure(!passwordMatch ? "dealer_wrong_password" : dealerRefusalReason(refusal!))
    return refused
  }

  const second = await dealerSecondFactor(row, input.code)
  if (second.kind !== "not_enrolled" && second.kind !== "verified") {
    await recordFailure("dealer_second_factor")
    return refused
  }

  await withoutTenantScope(async () => {
    await prisma.dealerUser.update({ where: { id: row.id }, data: { lastLoginAt: new Date() } })
  }).catch((err: unknown) => { console.error("[auth] dealer lastLoginAt update failed:", err) })
  const audit = dealerAuditFields({ dealerId: row.dealerId, dealerUserId: row.id, email: row.email })
  await logAudit({
    tenantId: row.tenantId,
    userId: audit.userId,
    userEmail: audit.userEmail,
    action: AuditAction.DEALER_SIGNED_IN,
    entity: "DealerUser",
    entityId: row.id,
    newValue: { actor: audit.actor },
  })
  return {
    ok: true,
    user: {
      id: row.id, email: row.email, name: row.name, role: "DEALER", tenantId: row.tenantId,
      dealerId: row.dealerId, dealerRole: row.role, tokenVersion: row.tokenVersion,
      totpVerified: false, totpEnrolmentRequired: false,
    },
  }
}
