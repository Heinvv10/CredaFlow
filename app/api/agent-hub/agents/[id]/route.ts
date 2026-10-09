import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { parseCommissionBps } from "../commission"

const VALID_AGENT_STATUSES = new Set(["ACTIVE", "SUSPENDED", "CLOSED"])

function cleanNullable(value: unknown, max = 1000) {
  if (typeof value !== "string") return undefined
  const text = value.trim().slice(0, max)
  return text || null
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const existing = await prisma.referralAgent.findFirst({ where: { id, tenantId: tenant.id } })
    if (!existing) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

    const body = await req.json() as { status?: string; notes?: string; displayName?: string; commissionBps?: number | null }
    const data: { status?: string; notes?: string | null; displayName?: string; commissionBps?: number | null } = {}

    if (body.status !== undefined) {
      const status = String(body.status).toUpperCase()
      if (!VALID_AGENT_STATUSES.has(status)) return NextResponse.json({ error: "Invalid agent status" }, { status: 400 })
      data.status = status
    }
    if (body.notes !== undefined) data.notes = cleanNullable(body.notes)
    if (body.displayName !== undefined) {
      const displayName = String(body.displayName).trim().slice(0, 120)
      if (!displayName) return NextResponse.json({ error: "displayName cannot be blank" }, { status: 400 })
      data.displayName = displayName
    }
    if (body.commissionBps !== undefined) {
      const parsed = parseCommissionBps(body.commissionBps)
      if (!parsed.ok) return NextResponse.json({ error: "commissionBps must be an integer between 0 and 10000, or null" }, { status: 400 })
      data.commissionBps = parsed.value
    }

    if (Object.keys(data).length === 0) return NextResponse.json({ error: "No supported changes supplied" }, { status: 400 })

    const updated = await prisma.referralAgent.update({ where: { id }, data })
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "REFERRAL_AGENT_UPDATED",
      entity: "ReferralAgent",
      entityId: id,
      oldValue: { status: existing.status, displayName: existing.displayName, notes: existing.notes, commissionBps: existing.commissionBps },
      newValue: data,
    })
    return NextResponse.json(updated)
  })
}
