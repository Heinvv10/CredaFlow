import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import type { ComplaintStatus, ComplaintOutcome } from "@prisma/client"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const complaint = await prisma.complaint.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, idNumber: true, phone: true, email: true },
        },
      },
    })

    if (!complaint) return NextResponse.json({ error: "Complaint not found" }, { status: 404 })

    return NextResponse.json(complaint)
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json() as {
      status?: ComplaintStatus
      assignedToId?: string
      resolution?: string
      outcome?: ComplaintOutcome
      resolvedAt?: string
    }

    const updateData: Record<string, unknown> = {}
    if (body.status !== undefined) updateData.status = body.status
    if (body.assignedToId !== undefined) updateData.assignedToId = body.assignedToId
    if (body.resolution !== undefined) updateData.resolution = body.resolution
    if (body.outcome !== undefined) updateData.outcome = body.outcome
    if (body.resolvedAt !== undefined) updateData.resolvedAt = new Date(body.resolvedAt)

    // Auto-set resolvedAt if status moves to RESOLVED/CLOSED and not explicitly provided
    if (
      (body.status === "RESOLVED" || body.status === "CLOSED") &&
      !body.resolvedAt
    ) {
      updateData.resolvedAt = new Date()
    }

    // Auto-set acknowledgedAt when complaint moves to UNDER_INVESTIGATION
    if (body.status === "UNDER_INVESTIGATION") {
      // Only set if not already acknowledged — fetch current record
      const existing = await prisma.complaint.findFirst({
        where: { id, tenantId: tenant.id },
        select: { acknowledgedAt: true },
      })
      if (existing && !existing.acknowledgedAt) {
        updateData.acknowledgedAt = new Date()
      }
    }

    // Switch to updateMany so tenantId can be included in the where clause
    const result = await prisma.complaint.updateMany({
      where: { id, tenantId: tenant.id },
      data: updateData,
    })

    if (result.count === 0) {
      return NextResponse.json({ error: "Complaint not found" }, { status: 404 })
    }

    const complaint = await prisma.complaint.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    })

    return NextResponse.json(complaint)
  })
}
