import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async () => {
    try {
      const logs = await prisma.breachLog.findMany({
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

  return withTenantContext(req, async () => {
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

      const log = await prisma.breachLog.create({
        data: {
          incidentDate: new Date(body.incidentDate),
          discoveredDate: new Date(body.discoveredDate),
          description: body.description,
          affectedClients: body.affectedClients ?? 0,
          dataCategories: body.dataCategories,
          containmentAction: body.containmentAction ?? null,
          reportedToIC: body.reportedToIC ?? false,
          reportedAt: body.reportedAt ? new Date(body.reportedAt) : null,
          status: "OPEN",
          createdBy: guard.user.id,
        },
      })

      return NextResponse.json(log, { status: 201 })
    } catch {
      return NextResponse.json({ error: "Failed to create breach log" }, { status: 500 })
    }
  })
}
