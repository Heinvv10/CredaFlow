import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { superAdminPolicyWrite } from "@/lib/security/policy-write-guard"
import { applyPortalPolicy, type PortalPolicyUpdate } from "@/lib/portal/portal-policy"

/**
 * Signing OTP and portal self-registration switches (Settings → Security &
 * KYC policy). Body: { requireSigningOtp, signingOtpBranchExempt,
 * allowNewRegistrations }, all booleans. SUPER_ADMIN with a TOTP-verified
 * session only. featurePortal itself is set in the tenant admin.
 */
export async function PUT(req: NextRequest) {
  return superAdminPolicyWrite(
    req,
    (body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const keys = ["requireSigningOtp", "signingOtpBranchExempt", "allowNewRegistrations"] as const
      if (keys.some((k) => typeof b[k] !== "boolean")) {
        return NextResponse.json(
          { error: "requireSigningOtp, signingOtpBranchExempt and allowNewRegistrations must each be true or false." },
          { status: 400 },
        )
      }
      return {
        requireSigningOtp: b.requireSigningOtp,
        signingOtpBranchExempt: b.signingOtpBranchExempt,
        allowNewRegistrations: b.allowNewRegistrations,
      } as PortalPolicyUpdate
    },
    async (tx, input, ctx) => {
      const result = await applyPortalPolicy(tx, {
        tenantId: ctx.tenantId, actor: ctx.actor, next: input as PortalPolicyUpdate, ipAddress: ctx.ip,
      })
      return NextResponse.json({ ok: true, changed: result.changed, ...result.policy })
    },
  )
}
