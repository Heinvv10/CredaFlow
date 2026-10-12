import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isAssignableStaff } from "@/lib/crm/staff"
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
    if (typeof body.clientId !== "string" || (body.assignedToId != null && typeof body.assignedToId !== "string")) {
      return NextResponse.json({ error: "clientId and assignedToId must be strings" }, { status: 400 })
    }

    // The tenant scope stamps tenantId on the complaint but does not check the
    // ids it is handed: clientId would take another tenant's client, and
    // assignedToId has no FK at all (User is not tenant-scoped). An id from
    // another tenant answers exactly as one that does not exist.
    const client = await prisma.client.findFirst({
      where: { id: body.clientId, tenantId: tenant.id },
      select: { id: true },
    })
    if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })
    if (
      body.assignedToId &&
      !(await isAssignableStaff(prisma.user, { tenantId: tenant.id, userId: body.assignedToId }))
    ) {
      return NextResponse.json({ error: "Assignee not found" }, { status: 404 })
    }

    // The complaint and its audit row commit together.
    const complaint = await prisma.$transaction(async (tx) => {
      const created = await tx.complaint.create({
        data: {
          tenantId: tenant.id,
          clientId: client.id,
          reference: generateReference("COMP"),
          category: body.category,
          description: body.description,
          status: "OPEN",
          assignedToId: body.assignedToId || null,
          createdById: guard.user.id,
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
        action: AuditAction.COMPLAINT_CREATED,
        entity: "Complaint",
        entityId: created.id,
        newValue: {
          reference: created.reference,
          clientId: created.clientId,
          category: created.category,
          status: created.status,
          assignedToId: created.assignedToId,
        },
      }, tx)
      return created
    })

    return NextResponse.json(complaint, { status: 201 })
  })
}
