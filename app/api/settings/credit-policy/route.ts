import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { parseCreditPolicyInput } from "@/lib/decision/credit-policy-input"
import { lockAffordabilityTenantPolicy } from "@/lib/affordability/evidence-locks"

// Schema defaults (prisma/schema.prisma model TenantConfig). Used to hydrate the
// form and to record the "old" audit value when no config row exists yet.
const DEFAULTS = { bureauMinScore: 450, bureauBlockAdverse: false, ndiBufferPct: 110 } as const

const SELECT = { bureauMinScore: true, bureauBlockAdverse: true, ndiBufferPct: true } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: SELECT,
      })
      return NextResponse.json({
        bureauMinScore: config?.bureauMinScore ?? DEFAULTS.bureauMinScore,
        bureauBlockAdverse: config?.bureauBlockAdverse ?? DEFAULTS.bureauBlockAdverse,
        ndiBufferPct: config?.ndiBufferPct ?? DEFAULTS.ndiBufferPct,
      })
    } catch (e) {
      console.error("Failed to load credit policy:", e)
      return NextResponse.json({ error: "Failed to load credit policy" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    try {
      const parsed = parseCreditPolicyInput(body)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      const { values } = parsed

      // Read-then-write in one transaction so the audited "old" value is exactly
      // the state this write replaced, even under concurrent policy edits.
      await prisma.$transaction(async (tx) => {
        // Coordinate both updates and first-row creation with final lending
        // decisions. A row-level lock alone cannot protect an absent config
        // row, so approval takes this same tenant-scoped advisory lock.
        await lockAffordabilityTenantPolicy(tx, { tenantId: tenant.id })
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
            action: AuditAction.CREDIT_POLICY_UPDATED,
            entity: "TenantConfig",
            entityId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            oldValue: prev ?? { ...DEFAULTS },
            newValue: values,
            ipAddress: callerIp(req),
          },
        })
      })

      return NextResponse.json({ ok: true, ...values })
    } catch (e) {
      console.error("Failed to update credit policy:", e)
      return NextResponse.json({ error: "Failed to update credit policy" }, { status: 500 })
    }
  })
}
