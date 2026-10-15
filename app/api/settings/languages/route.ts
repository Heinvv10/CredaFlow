import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { applyTenantLanguages } from "@/lib/i18n/language-settings"

// The tenant's borrower languages (lib/i18n). Only a SUPER_ADMIN of the
// tenant changes them, in a TOTP-verified session wherever the tenant
// requires staff TOTP. Enabling af/zu/xh needs a native-speaker review
// acknowledgement per language; applyTenantLanguages validates and audits.
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if ((await isStaffTotpRequired(tenant.id)) && actor.totpVerified !== true) {
      return NextResponse.json(
        { error: "Sign in with two-factor authentication to change the languages. Enable it under Settings → Security, then sign out and back in." },
        { status: 403 },
      )
    }
    const body = (await req.json().catch(() => null)) as { enabledLanguages?: unknown; languageReviewAcknowledgements?: unknown } | null
    if (body === null) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })

    const applied = await prisma.$transaction((tx) => applyTenantLanguages(tx, {
      tenantId: tenant.id,
      actor: { id: actor.id, email: actor.email },
      input: { enabledLanguages: body.enabledLanguages, acknowledgements: body.languageReviewAcknowledgements },
      ipAddress: callerIp(req),
    }))
    if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 400 })

    if (applied.changed) {
      try {
        revalidateTag(`tenant-config-${tenant.id}`, { expire: 0 })
      } catch (e) {
        // Committed; a failed invalidation only leaves the old list cached for 300 s.
        console.error("Languages saved but tenant-config cache was not invalidated:", e)
      }
    }
    return NextResponse.json({ ok: true, changed: applied.changed, enabledLanguages: applied.enabled, languageReviews: applied.reviews })
  })
}
