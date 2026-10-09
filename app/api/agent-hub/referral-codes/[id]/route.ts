import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

const VALID_CODE_STATUSES = new Set(["ACTIVE", "PAUSED", "RETIRED"])

function cleanNullable(value: unknown, max = 160) {
  if (typeof value !== "string") return undefined
  const text = value.trim().slice(0, max)
  return text || null
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const existing = await prisma.referralCode.findFirst({ where: { id, tenantId: tenant.id } })
    if (!existing) return NextResponse.json({ error: "Referral code not found" }, { status: 404 })

    const body = await req.json() as { status?: string; label?: string; campaign?: string }
    const data: { status?: string; label?: string | null; campaign?: string | null } = {}

    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase()
      if (!VALID_CODE_STATUSES.has(status)) return NextResponse.json({ error: "Invalid referral-code status" }, { status: 400 })
      data.status = status
    }
    if (body.label !== undefined) data.label = cleanNullable(body.label, 120)
    if (body.campaign !== undefined) data.campaign = cleanNullable(body.campaign, 120)

    if (Object.keys(data).length === 0) return NextResponse.json({ error: "No supported changes supplied" }, { status: 400 })

    const updated = await prisma.referralCode.update({ where: { id }, data })
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "REFERRAL_CODE_UPDATED",
      entity: "ReferralCode",
      entityId: id,
      oldValue: { status: existing.status, label: existing.label, campaign: existing.campaign },
      newValue: data,
    })
    return NextResponse.json(updated)
  })
}
