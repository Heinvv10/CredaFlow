import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params

      const client = await prisma.client.findUnique({ where: { id: clientId, tenantId: tenant.id }, select: { id: true } })
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

      const records = await prisma.complianceRecord.findMany({
        where: {
          tenantId: tenant.id,
          type: "FAIS_DISCLOSURE",
          referenceId: clientId,
        },
        orderBy: { createdAt: "desc" },
      })

      return NextResponse.json(records)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch FAIS disclosures" }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { id: clientId } = await params

      const client = await prisma.client.findUnique({ where: { id: clientId, tenantId: tenant.id }, select: { id: true } })
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

      const body = await req.json() as { notes?: string; date?: string }

      const disclosureDate = body.date ? new Date(body.date) : new Date()

      const record = await prisma.complianceRecord.create({
        data: {
          tenantId: tenant.id,
          type: "FAIS_DISCLOSURE",
          referenceId: clientId,
          status: "COMPLETED",
          completedAt: disclosureDate,
          data: {
            notes: body.notes ?? null,
            loggedById: guard.user.id,
            loggedByName: guard.user.name ?? guard.user.email,
          },
        },
      })

      return NextResponse.json(record, { status: 201 })
    })
  } catch {
    return NextResponse.json({ error: "Failed to log FAIS disclosure" }, { status: 500 })
  }
}
