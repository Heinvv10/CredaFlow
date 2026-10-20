/**
 * Who may hold a dealer portal session — one rule set, applied at sign-in
 * (lib/dealer/sign-in.ts) and on every request (revalidateDealerPrincipal,
 * from the jwt callback in lib/auth.ts, which runs it BEFORE the staff branch:
 * revalidatePrincipal would find no User row and sign the dealer out).
 *
 * Refused: the dealer user inactive or without a password; the dealer
 * inactive; the lender SUSPENDED; the portal not enabled for the lender
 * (featureAssetFinance && featureDealerPortal && isDemoLender — until dealer
 * 2FA ships the portal is demo-only, as the DB CHECK
 * TenantConfig_dealer_portal_demo_only says). On a request also: the token's
 * tokenVersion, tenant or dealer differing from the row's. Deactivating a user
 * bumps its tokenVersion; deactivating a dealer bumps every user's
 * (lib/dealer/users.ts), so a session ends on its next request either way.
 */
import type { DealerRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"

export type DealerPortalFlags = {
  featureAssetFinance: boolean
  featureDealerPortal: boolean
  isDemoLender: boolean
}

export const DEALER_PORTAL_FLAG_SELECT = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } as const

export function dealerPortalEnabled(config: DealerPortalFlags | null | undefined): boolean {
  return !!config && config.featureAssetFinance && config.featureDealerPortal && config.isDemoLender
}

export type DealerPrincipalRow = {
  id: string
  tenantId: string
  dealerId: string
  email: string
  name: string
  role: DealerRole
  active: boolean
  passwordHash: string | null
  tokenVersion: number
  dealer: {
    active: boolean
    tenant: { status: string; config: DealerPortalFlags | null }
  }
}

export const DEALER_PRINCIPAL_SELECT = {
  id: true, tenantId: true, dealerId: true, email: true, name: true, role: true, active: true, passwordHash: true, tokenVersion: true,
  dealer: { select: { active: true, tenant: { select: { status: true, config: { select: DEALER_PORTAL_FLAG_SELECT } } } } },
} as const

export type DealerPrincipalRefusal = "user_inactive" | "password_unset" | "dealer_inactive" | "tenant_suspended" | "portal_off"

export function dealerPrincipalRefusal(row: DealerPrincipalRow): DealerPrincipalRefusal | null {
  if (!row.active) return "user_inactive"
  if (!row.passwordHash) return "password_unset"
  if (!row.dealer.active) return "dealer_inactive"
  if (row.dealer.tenant.status === "SUSPENDED") return "tenant_suspended"
  if (!dealerPortalEnabled(row.dealer.tenant.config)) return "portal_off"
  return null
}

/** The FailedLoginAttempt reason for a refusal at sign-in. */
export function dealerRefusalReason(refusal: DealerPrincipalRefusal): "dealer_inactive" | "dealer_portal_off" {
  return refusal === "portal_off" ? "dealer_portal_off" : "dealer_inactive"
}

/** The dealer user, with the dealer and lender state the rules read. Any tenant: the caller binds it. */
export async function loadDealerPrincipal(where: { id: string } | { tenantId: string; email: string }): Promise<DealerPrincipalRow | null> {
  return withoutTenantScope(async () => {
    return await prisma.dealerUser.findUnique({
      where: "id" in where ? { id: where.id } : { tenantId_email: where },
      select: DEALER_PRINCIPAL_SELECT,
    })
  })
}

export type DealerSessionClaims = { tenantId: unknown; dealerId: unknown; tokenVersion: unknown }

/**
 * The session's dealer user as the database has it now. null → sign out;
 * "error" → transient DB failure (the caller keeps an already-bound token).
 */
export async function revalidateDealerPrincipal(
  dealerUserId: string,
  claims: DealerSessionClaims,
): Promise<{ dealerRole: DealerRole; tenantId: string; dealerId: string } | null | "error"> {
  let row: DealerPrincipalRow | null
  try {
    row = await loadDealerPrincipal({ id: dealerUserId })
  } catch (err) {
    console.error("[auth] revalidateDealerPrincipal DB error — retaining existing token:", err)
    return "error"
  }
  if (!row || dealerPrincipalRefusal(row)) return null
  if (row.tenantId !== claims.tenantId || row.dealerId !== claims.dealerId || row.tokenVersion !== claims.tokenVersion) return null
  return { dealerRole: row.role, tenantId: row.tenantId, dealerId: row.dealerId }
}
