import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp } from "@/lib/rate-limit"
import { parseReferralCommissionInput } from "@/lib/referral-agents/commission-rate-input"

// Schema default (prisma/schema.prisma model TenantConfig). Used to hydrate the
// form and to record the "old" audit value when no config row exists yet.
const DEFAULT_BPS = 0

const SELECT = { referralCommissionBps: true } as const

// ADMIN, not LOAN_ADMIN. A per-agent override prices one agent; this default
// prices every agent who has no override, so it is a strictly higher-privilege
// lever than the per-agent editor on the same page.
const REQUIRED_ROLE = "ADMIN"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole(REQUIRED_ROLE)
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: SELECT,
      })
      return NextResponse.json({
        referralCommissionBps: config?.referralCommissionBps ?? DEFAULT_BPS,
      })
    } catch (e) {
      console.error("Failed to load referral commission rate:", e)
      return NextResponse.json({ error: "Failed to load referral commission rate" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole(REQUIRED_ROLE)
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    try {
      const parsed = parseReferralCommissionInput(body)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      const { values } = parsed

      // Read-then-write in one transaction so the audited "old" value is exactly
      // the state this write replaced, even under concurrent edits. The audit row
      // is written inside the same transaction: this rate prices every future
      // accrual, so a rate change with no audit row must not be able to commit.
      await prisma.$transaction(async (tx) => {
        const prev = await tx.tenantConfig.findUnique({
          where: { tenantId: tenant.id },
          select: SELECT,
        })
        await tx.tenantConfig.upsert({
          where: { tenantId: tenant.id },
          update: values,
          create: { tenantId: tenant.id, ...values },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "REFERRAL_COMMISSION_RATE_UPDATED",
            entity: "TenantConfig",
            entityId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            oldValue: prev ?? { referralCommissionBps: DEFAULT_BPS },
            newValue: values,
            ipAddress: callerIp(req),
          },
        })
      })

      return NextResponse.json({ ok: true, ...values })
    } catch (e) {
      console.error("Failed to update referral commission rate:", e)
      return NextResponse.json({ error: "Failed to update referral commission rate" }, { status: 500 })
    }
  })
}
