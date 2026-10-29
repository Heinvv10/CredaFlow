import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { sastCalendarDate } from "@/lib/date/sast"
import { parseSettingsInput, withEffectiveMonth } from "@/lib/ifrs9/settings"
import { loadSettings, saveSettings } from "@/lib/ifrs9/store"

// The lender's IFRS 9 staging and interest-suspension policy (lib/ifrs9).
// GET: LOAN_ADMIN. PUT a partial body: ADMIN, TOTP when required, audited. Switching it on without an
// effectiveFromMonth makes it effective from the current month.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await loadSettings(prisma, tenant.id)))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the IFRS 9 settings")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const current = await loadSettings(prisma, tenant.id)
    const parsed = parseSettingsInput(read.body, current)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const settings = withEffectiveMonth(parsed.settings, current, sastCalendarDate(new Date()))
    await saveSettings(prisma, tenant.id, settings, guard.user)
    return NextResponse.json(settings)
  })
}
