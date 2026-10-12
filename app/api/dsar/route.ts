import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { generateReference } from "@/lib/utils"
import type { DsarType, DsarStatus } from "@prisma/client"

const DSAR_DUE_DAYS = 30

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = req.nextUrl
    const status = searchParams.get("status") as DsarStatus | null
    const type = searchParams.get("type") as DsarType | null
    const clientId = searchParams.get("clientId")

    const dsars = await prisma.dataSubjectRequest.findMany({
      where: {
        tenantId: tenant.id,
        ...(status && { status }),
        ...(type && { type }),
        ...(clientId && { clientId }),
      },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, idNumber: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json(dsars)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      clientId: string
      type: DsarType
      description?: string
    }

    if (!body.clientId || !body.type) {
      return NextResponse.json({ error: "clientId and type are required" }, { status: 400 })
    }
    if (typeof body.clientId !== "string") {
      return NextResponse.json({ error: "clientId must be a string" }, { status: 400 })
    }

    // The tenant scope stamps tenantId on the request but does not check the
    // clientId it is handed, which would take another tenant's client. An id
    // from another tenant answers exactly as one that does not exist.
    const client = await prisma.client.findFirst({
      where: { id: body.clientId, tenantId: tenant.id },
      select: { id: true },
    })
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + DSAR_DUE_DAYS)

    // The request and its audit row commit together.
    const dsar = await prisma.$transaction(async (tx) => {
      const created = await tx.dataSubjectRequest.create({
        data: {
          tenantId: tenant.id,
          clientId: client.id,
          reference: generateReference("DSAR"),
          type: body.type,
          description: body.description ?? null,
          status: "RECEIVED",
          dueDate,
        },
        include: {
          client: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.DSAR_CREATED,
        entity: "DataSubjectRequest",
        entityId: created.id,
        newValue: {
          reference: created.reference,
          clientId: created.clientId,
          type: created.type,
          status: created.status,
          dueDate: created.dueDate.toISOString(),
        },
      }, tx)
      return created
    })

    return NextResponse.json(dsar, { status: 201 })
  })
}
