import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import {
  BREACH_LOG_TRANSITIONS,
  canMoveBreachLog,
  isBreachLogStatus,
  parseBreachLogDate,
} from "@/lib/compliance/breach-log"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const { id } = await params
      const log = await prisma.breachLog.findFirst({ where: { id, tenantId: tenant.id } })
      if (!log) return NextResponse.json({ error: "Breach log not found" }, { status: 404 })

      return NextResponse.json(log)
    } catch {
      return NextResponse.json({ error: "Failed to fetch breach log" }, { status: 500 })
    }
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 })
    }
    const reportedAt = body.reportedAt === undefined || body.reportedAt === null ? null : parseBreachLogDate(body.reportedAt)
    if (
      (body.status !== undefined && !isBreachLogStatus(body.status))
      || (body.containmentAction !== undefined && body.containmentAction !== null && typeof body.containmentAction !== "string")
      || (body.reportedToIC !== undefined && typeof body.reportedToIC !== "boolean")
      || (body.reportedAt !== undefined && body.reportedAt !== null && !reportedAt)
    ) {
      return NextResponse.json(
        { error: `status must be one of ${Object.keys(BREACH_LOG_TRANSITIONS).join(", ")}; reportedToIC a boolean; reportedAt a date or null; containmentAction text or null` },
        { status: 400 }
      )
    }
    const data = {
      ...(body.status !== undefined && { status: body.status as string }),
      ...(body.containmentAction !== undefined && { containmentAction: body.containmentAction as string | null }),
      ...(body.reportedToIC !== undefined && { reportedToIC: body.reportedToIC as boolean }),
      ...(body.reportedAt !== undefined && { reportedAt }),
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change" }, { status: 400 })
    }

    try {
      // The edit and its audit row commit together: the row keeps no history,
      // so the values it replaces survive only in the audit row. They are read
      // under a row lock, so a concurrent edit waits and then sees this one.
      const result = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "BreachLog"
          WHERE "id" = ${id} AND "tenantId" = ${tenant.id}
          FOR UPDATE
        `)
        const existing = await tx.breachLog.findFirst({
          where: { id, tenantId: tenant.id },
          select: { status: true, containmentAction: true, reportedToIC: true, reportedAt: true },
        })
        if (!existing) return { kind: "missing" as const }
        if (data.status !== undefined && !canMoveBreachLog(existing.status, data.status)) {
          return { kind: "transition" as const, from: existing.status }
        }

        const updated = await tx.breachLog.update({ where: { id, tenantId: tenant.id }, data })
        // The containment action is free text that can name the people
        // affected, like the description POST keeps out: only whether it changed.
        const fields = (["status", "reportedToIC", "reportedAt"] as const).filter((field) => field in data)
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.BREACH_LOG_UPDATED,
          entity: "BreachLog",
          entityId: id,
          oldValue: Object.fromEntries(fields.map((field) => [field, existing[field]])),
          newValue: {
            ...Object.fromEntries(fields.map((field) => [field, updated[field]])),
            ...("containmentAction" in data && { containmentActionChanged: existing.containmentAction !== updated.containmentAction }),
          },
        }, tx)
        return { kind: "updated" as const, log: updated }
      })

      if (result.kind === "missing") return NextResponse.json({ error: "Breach log not found" }, { status: 404 })
      if (result.kind === "transition") {
        return NextResponse.json({ error: `A ${result.from} breach cannot move to ${data.status}` }, { status: 409 })
      }
      return NextResponse.json(result.log)
    } catch (error) {
      // The error's name and code only: a database error can quote the row.
      console.error("[breach-log] update failed", {
        action: AuditAction.BREACH_LOG_UPDATED,
        entity: "BreachLog",
        entityId: id,
        tenantId: tenant.id,
        userId: user.id,
        error: error instanceof Error ? error.name : typeof error,
        code: (error as { code?: unknown } | null)?.code,
      })
      return NextResponse.json({ error: "Failed to update breach log" }, { status: 500 })
    }
  })
}
