import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"

/**
 * The FIC registers (STR, CTR, exports, RMCP) hold the lender's most
 * sensitive records. Where the lender requires staff 2FA, a session that did
 * not verify TOTP at sign-in may not read or change them — the same claim as
 * /api/settings/screening. A missing TenantConfig fails closed (2FA required).
 * The TOTP-free demo stack (demoStaffWithoutTotp) is the one exception.
 */
export async function ficSessionNeedsTotp(user: { totpVerified?: boolean }, tenantId: string): Promise<boolean> {
  if (user.totpVerified === true || demoStaffWithoutTotp()) return false
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { requireStaffTotp: true } })
  return config?.requireStaffTotp ?? true
}

export const FIC_TOTP_ERROR = "Sign in with two-factor authentication to use the FIC registers."

/** 403 for an FIC route when the session needs TOTP and did not verify it; null to proceed. */
export async function ficTotpRefusal(user: { totpVerified?: boolean }, tenantId: string): Promise<NextResponse | null> {
  return (await ficSessionNeedsTotp(user, tenantId))
    ? NextResponse.json({ error: FIC_TOTP_ERROR, code: "totp_required" }, { status: 403 })
    : null
}
