import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { refuseLockedStaffUserWrite, requireApiRole, staffUserWriteConflict } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"

// The lender's Statement AI switch (TenantConfig.featureStatementAi). It is a
// paid option, so only a SUPER_ADMIN of the tenant changes it; the change and
// its audit row commit together.

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const row = await prisma.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { featureStatementAi: true } })
    return NextResponse.json({ featureStatementAi: row?.featureStatementAi ?? false })
  })
}

/** Body: `{ featureStatementAi: boolean }`. */
export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { featureStatementAi?: unknown } | null
    if (typeof body?.featureStatementAi !== "boolean") {
      return NextResponse.json({ error: "featureStatementAi must be true or false." }, { status: 400 })
    }
    const enabled = body.featureStatementAi

    const result = await prisma.$transaction(async (tx) => {
      // The session is stale by the time of the write: re-check the caller's row, locked, and its role now.
      const locked = await refuseLockedStaffUserWrite(tx, actor, { tenantId: tenant.id, assignedRole: undefined })
      if (locked.refused) return { refused: locked.refused }
      if (locked.callerRole !== "SUPER_ADMIN") return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
      // The advisory lock serialises first writes, where no config row exists yet.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`statement-ai-settings:${tenant.id}`}))`
      const prev = (await tx.tenantConfig.findUnique({ where: { tenantId: tenant.id }, select: { featureStatementAi: true } }))?.featureStatementAi ?? false
      if (prev === enabled) return { refused: null, changed: false }
      await tx.tenantConfig.upsert({
        where: { tenantId: tenant.id },
        update: { featureStatementAi: enabled },
        create: { tenantId: tenant.id, featureStatementAi: enabled },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: actor.id,
        userEmail: actor.email,
        ipAddress: recordedCallerIp(req) ?? undefined,
        action: enabled ? AuditAction.STATEMENT_AI_ENABLED : AuditAction.STATEMENT_AI_DISABLED,
        entity: "TenantConfig",
        entityId: tenant.id,
        oldValue: { featureStatementAi: prev },
        newValue: { featureStatementAi: enabled },
      }, tx)
      return { refused: null, changed: true }
    }).catch((err: unknown) => {
      const conflict = staffUserWriteConflict(err)
      if (conflict) return { refused: conflict, changed: false }
      throw err
    })
    if (result.refused) return result.refused
    return NextResponse.json({ ok: true, changed: result.changed, featureStatementAi: enabled })
  })
}
