import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { registeredPayoutProviders } from "@/lib/payouts/registry"

// The payout channel (lib/payouts): payoutsEngineEnabled and payoutProvider.
// ADMIN; writes need TOTP when required and are audited. Turning the engine on
// requires an implemented provider.

const SELECT = { payoutsEngineEnabled: true, payoutProvider: true } as const

function view(row: { payoutsEngineEnabled: boolean; payoutProvider: string | null } | null) {
  return {
    payoutsEngineEnabled: row?.payoutsEngineEnabled ?? false,
    payoutProvider: row?.payoutProvider ?? null,
    providers: registeredPayoutProviders().map((p) => ({ id: p.id, displayName: p.displayName, implemented: p.capabilities.implemented, statusQuery: p.capabilities.statusQuery })),
  }
}

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(view(await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT }))))
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "change the payout channel")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const body = (read.body ?? {}) as Record<string, unknown>
    if (typeof body.payoutsEngineEnabled !== "boolean") return NextResponse.json({ error: "payoutsEngineEnabled must be true or false" }, { status: 400 })
    const providerId = body.payoutProvider === null || body.payoutProvider === "" ? null : body.payoutProvider
    const provider = typeof providerId === "string" ? registeredPayoutProviders().find((p) => p.id === providerId) : null
    if (providerId !== null && !provider) return NextResponse.json({ error: "Unknown payout provider" }, { status: 400 })
    if (body.payoutsEngineEnabled && !provider?.capabilities.implemented) {
      return NextResponse.json({ error: "Choose an implemented payout provider before turning payouts on" }, { status: 422 })
    }
    const data = { payoutsEngineEnabled: body.payoutsEngineEnabled, payoutProvider: provider?.id ?? null }
    const row = await prisma.$transaction(async (tx) => {
      const before = await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: SELECT })
      const saved = await tx.tenantConfig.upsert({ where: { tenantId: tenant.id }, update: data, create: { tenantId: tenant.id, ...data }, select: SELECT })
      await logAuditStrict({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email, action: AuditAction.PAYOUT_SETTINGS_UPDATED,
        entity: "TenantConfig", entityId: tenant.id, ipAddress: callerIp(req), oldValue: before, newValue: data,
      }, tx)
      return saved
    })
    return NextResponse.json(view(row))
  })
}
