import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { LENDER_IDENTITY_FIELDS, LENDER_IDENTITY_SELECT, storedDateString } from "@/lib/config/identity"
import { updateLenderIdentity } from "@/lib/config/identity-write"

// ADMIN: these values print on every NCA document and customer message.
const REQUIRED_ROLE = "ADMIN"

// TOTP is enforced at sign-in only for accounts that enrolled, and a
// password-only session can enrol mid-session. Writes therefore require that
// THIS session's sign-in verified a TOTP code (the totpVerified claim set in
// lib/auth.ts), not merely that the account has TOTP turned on.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole(REQUIRED_ROLE)
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: LENDER_IDENTITY_SELECT,
      })
      const identity = Object.fromEntries(LENDER_IDENTITY_FIELDS.map((field) => [field, storedDateString(config?.[field]) ?? null]))
      return NextResponse.json({ identity })
    } catch (e) {
      console.error("Failed to load lender identity:", e)
      return NextResponse.json({ error: "Failed to load lender identity" }, { status: 500 })
    }
  })
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole(REQUIRED_ROLE)
  if (guard.error) return guard.error

  if (guard.user.totpVerified !== true) {
    return NextResponse.json(
      { error: "Sign in with two-factor authentication to edit the lender identity. Enable it under Settings → Security, then sign out and back in." },
      { status: 403 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    try {
      const result = await updateLenderIdentity(prisma, {
        tenantId: tenant.id,
        actor: { id: guard.user.id, email: guard.user.email },
        input: body,
        ipAddress: callerIp(req),
      })
      if (!result.ok) {
        return NextResponse.json({ error: "Invalid lender identity.", errors: result.errors }, { status: 400 })
      }
      return NextResponse.json({ ok: true, changed: result.changed, identity: result.identity })
    } catch (e) {
      console.error("Failed to update lender identity:", e)
      return NextResponse.json({ error: "Failed to update lender identity" }, { status: 500 })
    }
  })
}
