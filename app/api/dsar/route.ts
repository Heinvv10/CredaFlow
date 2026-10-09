import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
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

    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + DSAR_DUE_DAYS)

    const dsar = await prisma.dataSubjectRequest.create({
      data: {
        tenantId: tenant.id,
        clientId: body.clientId,
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

    return NextResponse.json(dsar, { status: 201 })
  })
}
