import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { applyStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { applyKycOverridePolicy, isKycOverrideMinRole } from "@/lib/kyc/override-policy"

// The lender's staff two-factor policy (TenantConfig.requireStaffTotp). Only a
// SUPER_ADMIN of the tenant changes it, in a session whose sign-in verified a
// TOTP code, switching on or off alike. The change and its audit row commit
// together (applyStaffTotpRequired).
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  if (actor.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to change the security policy. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const body: unknown = await req.json().catch(() => null)
    const candidate = body as {
      requireStaffTotp?: unknown
      kycOverrideEnabled?: unknown
      kycOverrideMinRole?: unknown
      kycOverrideSecondApprover?: unknown
    } | null
    const isTotpUpdate = candidate !== null && Object.hasOwn(candidate, "requireStaffTotp")
    const isKycUpdate = candidate !== null && (
      Object.hasOwn(candidate, "kycOverrideEnabled") ||
      Object.hasOwn(candidate, "kycOverrideMinRole") ||
      Object.hasOwn(candidate, "kycOverrideSecondApprover")
    )
    if (isTotpUpdate === isKycUpdate) {
      return NextResponse.json({ error: "Submit exactly one complete security policy update." }, { status: 400 })
    }
    if (isTotpUpdate && typeof candidate?.requireStaffTotp !== "boolean") {
      return NextResponse.json({ error: "requireStaffTotp must be true or false." }, { status: 400 })
    }
    if (isKycUpdate && (
      typeof candidate?.kycOverrideEnabled !== "boolean" ||
      !isKycOverrideMinRole(candidate?.kycOverrideMinRole) ||
      typeof candidate?.kycOverrideSecondApprover !== "boolean"
    )) {
      return NextResponse.json({
        error: "KYC override policy requires booleans for enabled and second approver, and minimum role BRANCH_MANAGER or ADMIN.",
      }, { status: 400 })
    }

    const result = await prisma.$transaction(async (tx) => {
      // The session is stale by the time of the write: re-check the caller's
      // row, locked, and its role as it is now.
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "SUPER_ADMIN") return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      if (isTotpUpdate) {
        return {
          kind: "totp" as const,
          applied: await applyStaffTotpRequired(tx, {
            tenantId: tenant.id,
            actor: { id: actor.id, email: actor.email },
            required: candidate!.requireStaffTotp as boolean,
            ipAddress: callerIp(req),
          }),
        }
      }
      return {
        kind: "kyc" as const,
        applied: await applyKycOverridePolicy(tx, {
          tenantId: tenant.id,
          actor: { id: actor.id, email: actor.email },
          enabled: candidate!.kycOverrideEnabled as boolean,
          minRole: candidate!.kycOverrideMinRole as "BRANCH_MANAGER" | "ADMIN",
          secondApprover: candidate!.kycOverrideSecondApprover as boolean,
          ipAddress: callerIp(req),
        }),
      }
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return { refused: conflict }
      throw err
    })
    if (result.refused) return result.refused

    if (result.kind === "totp") {
      const { changed, required: now, signedOut } = result.applied
      return NextResponse.json({ ok: true, changed, requireStaffTotp: now, signedOutUsers: signedOut })
    }
    return NextResponse.json({
      ok: true,
      changed: result.applied.changed,
      kycOverrideEnabled: result.applied.enabled,
      kycOverrideMinRole: result.applied.minRole,
      kycOverrideSecondApprover: result.applied.secondApprover,
    })
  })
}
