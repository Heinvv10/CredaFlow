import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"

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
    try {
      const body = await req.json() as {
        incidentDate: string
        discoveredDate: string
        description: string
        affectedClients?: number
        dataCategories: string
        containmentAction?: string
        reportedToIC?: boolean
        reportedAt?: string
      }

      if (!body.incidentDate || !body.discoveredDate || !body.description || !body.dataCategories) {
        return NextResponse.json(
          { error: "incidentDate, discoveredDate, description and dataCategories are required" },
          { status: 400 }
        )
      }

      // The entry and its audit row commit together: the register is a
      // statutory record, so an entry nobody can be shown to have made is
      // refused rather than written.
      const log = await prisma.$transaction(async (tx) => {
        const created = await tx.breachLog.create({
          data: {
            tenantId: tenant.id,
            incidentDate: new Date(body.incidentDate),
            discoveredDate: new Date(body.discoveredDate),
            description: body.description,
            affectedClients: body.affectedClients ?? 0,
            dataCategories: body.dataCategories,
            containmentAction: body.containmentAction ?? null,
            reportedToIC: body.reportedToIC ?? false,
            reportedAt: body.reportedAt ? new Date(body.reportedAt) : null,
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
    } catch {
      return NextResponse.json({ error: "Failed to create breach log" }, { status: 500 })
    }
  })
}
