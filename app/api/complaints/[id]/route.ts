import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isAssignableStaff } from "@/lib/crm/staff"
import { Prisma } from "@prisma/client"
import type { ComplaintStatus, ComplaintOutcome } from "@prisma/client"

// What a COMPLAINT_UPDATED audit row records, old and new. The resolution's
// words stay on the complaint; the audit row only says they changed.
const AUDITED_FIELDS = ["status", "assignedToId", "outcome", "acknowledgedAt", "resolvedAt"] as const
const auditValue = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null)

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
      assignedToId?: string | null
      resolution?: string
      outcome?: ComplaintOutcome
      resolvedAt?: string
    }

    if (body.assignedToId != null && typeof body.assignedToId !== "string") {
      return NextResponse.json({ error: "assignedToId must be a string" }, { status: 400 })
    }
    // assignedToId has no FK and User is not tenant-scoped, so an unchecked
    // value would store another tenant's user. An id from another tenant
    // answers exactly as one that does not exist.
    if (
      body.assignedToId &&
      !(await isAssignableStaff(prisma.user, { tenantId: tenant.id, userId: body.assignedToId }))
    ) {
      return NextResponse.json({ error: "Assignee not found" }, { status: 404 })
    }

    const updateData: Record<string, unknown> = {}
    if (body.status !== undefined) updateData.status = body.status
    if (body.assignedToId !== undefined) updateData.assignedToId = body.assignedToId || null
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

    // Lock, read, update and audit in one transaction: the change and its
    // audit row commit together, and the audited old values are exactly what
    // this write replaced even when two updates race.
    const complaint = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "Complaint" WHERE id = ${id} AND "tenantId" = ${tenant.id} FOR UPDATE`)
      const existing = await tx.complaint.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true, assignedToId: true, outcome: true, acknowledgedAt: true, resolvedAt: true },
      })
      if (!existing) return null

      // Auto-set acknowledgedAt when complaint moves to UNDER_INVESTIGATION,
      // only if not already acknowledged
      if (body.status === "UNDER_INVESTIGATION" && !existing.acknowledgedAt) {
        updateData.acknowledgedAt = new Date()
      }

      // updateMany so tenantId can be included in the where clause
      await tx.complaint.updateMany({
        where: { id, tenantId: tenant.id },
        data: updateData,
      })

      const changed = AUDITED_FIELDS.filter((field) => field in updateData)
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.COMPLAINT_UPDATED,
        entity: "Complaint",
        entityId: id,
        oldValue: Object.fromEntries(changed.map((field) => [field, auditValue(existing[field])])),
        newValue: {
          ...Object.fromEntries(changed.map((field) => [field, auditValue(updateData[field])])),
          ...("resolution" in updateData && { resolutionChanged: true }),
        },
      }, tx)

      return tx.complaint.findFirst({
        where: { id, tenantId: tenant.id },
        include: {
          client: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      })
    })

    if (!complaint) {
      return NextResponse.json({ error: "Complaint not found" }, { status: 404 })
    }

    return NextResponse.json(complaint)
  })
}
