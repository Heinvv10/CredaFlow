import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import { parseBreachLogDate } from "@/lib/compliance/breach-log"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const logs = await prisma.breachLog.findMany({
        where: { tenantId: tenant.id },
        orderBy: { incidentDate: "desc" },
      })

      return NextResponse.json(logs)
    } catch {
      return NextResponse.json({ error: "Failed to fetch breach logs" }, { status: 500 })
    }
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { user } = guard

  return withTenantContext(req, async (tenant) => {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 })
    }
    if (!body.incidentDate || !body.discoveredDate || !body.description || !body.dataCategories) {
      return NextResponse.json(
        { error: "incidentDate, discoveredDate, description and dataCategories are required" },
        { status: 400 }
      )
    }
    const incidentDate = parseBreachLogDate(body.incidentDate)
    const discoveredDate = parseBreachLogDate(body.discoveredDate)
    const reportedAt = body.reportedAt === undefined ? null : parseBreachLogDate(body.reportedAt)
    const affectedClients = body.affectedClients ?? 0
    if (
      !incidentDate || !discoveredDate || (body.reportedAt !== undefined && !reportedAt)
      || typeof body.description !== "string" || typeof body.dataCategories !== "string"
      || !Number.isInteger(affectedClients) || (affectedClients as number) < 0
      || (body.containmentAction !== undefined && typeof body.containmentAction !== "string")
      || (body.reportedToIC !== undefined && typeof body.reportedToIC !== "boolean")
    ) {
      return NextResponse.json(
        { error: "Dates must parse, affectedClients must be a whole number of 0 or more, reportedToIC a boolean and the text fields strings" },
        { status: 400 }
      )
    }

    try {

      // The entry and its audit row commit together: the register is a
      // statutory record, so an entry nobody can be shown to have made is
      // refused rather than written.
      const log = await prisma.$transaction(async (tx) => {
        const created = await tx.breachLog.create({
          data: {
            tenantId: tenant.id,
            incidentDate,
            discoveredDate,
            description: body.description as string,
            affectedClients: affectedClients as number,
            dataCategories: body.dataCategories as string,
            containmentAction: (body.containmentAction as string | undefined) ?? null,
            reportedToIC: (body.reportedToIC as boolean | undefined) ?? false,
            reportedAt,
            status: "OPEN",
            createdBy: user.id,
          },
        })
        // Not the description: free text about an incident can name the
        // people affected, and the audit trail is not a second copy of it.
        await logAuditStrict({
          tenantId: tenant.id,
          userId: user.id,
          userEmail: user.email,
          action: AuditAction.BREACH_LOG_CREATED,
          entity: "BreachLog",
          entityId: created.id,
          newValue: {
            incidentDate: created.incidentDate,
            discoveredDate: created.discoveredDate,
            affectedClients: created.affectedClients,
            dataCategories: created.dataCategories,
            reportedToIC: created.reportedToIC,
            reportedAt: created.reportedAt,
            status: created.status,
          },
        }, tx)
        return created
      })

      return NextResponse.json(log, { status: 201 })
    } catch (error) {
      // The error's name and code only: a database error can quote the row.
      console.error("[breach-log] create failed", {
        action: AuditAction.BREACH_LOG_CREATED,
        entity: "BreachLog",
        tenantId: tenant.id,
        userId: user.id,
        error: error instanceof Error ? error.name : typeof error,
        code: (error as { code?: unknown } | null)?.code,
      })
      return NextResponse.json({ error: "Failed to create breach log" }, { status: 500 })
    }
  })
}
