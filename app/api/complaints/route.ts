import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { generateReference } from "@/lib/utils"
import type { ComplaintCategory, ComplaintStatus } from "@prisma/client"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = req.nextUrl
    const status = searchParams.get("status") as ComplaintStatus | null
    const category = searchParams.get("category") as ComplaintCategory | null
    const clientId = searchParams.get("clientId")

    const complaints = await prisma.complaint.findMany({
      where: {
        tenantId: tenant.id,
        ...(status && { status }),
        ...(category && { category }),
        ...(clientId && { clientId }),
      },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, idNumber: true, phone: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    })

    return NextResponse.json(complaints)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      clientId: string
      category: ComplaintCategory
      description: string
      assignedToId?: string
    }

    if (!body.clientId || !body.category || !body.description) {
      return NextResponse.json({ error: "clientId, category and description are required" }, { status: 400 })
    }

    const complaint = await prisma.complaint.create({
      data: {
        tenantId: tenant.id,
        clientId: body.clientId,
        reference: generateReference("COMP"),
        category: body.category,
        description: body.description,
        status: "OPEN",
        assignedToId: body.assignedToId ?? null,
        createdById: guard.user.id,
      },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    })

    return NextResponse.json(complaint, { status: 201 })
  })
}
