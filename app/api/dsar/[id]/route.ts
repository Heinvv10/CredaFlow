import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { Prisma } from "@prisma/client"
import type { DsarStatus } from "@prisma/client"

// What a DSAR_UPDATED audit row records, old and new. The response's words
// stay on the request; the audit row only says they changed.
const AUDITED_FIELDS = ["status", "completedAt"] as const
const auditValue = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null)

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json() as {
      status?: DsarStatus
      response?: string
      completedAt?: string
    }

    const updateData: Record<string, unknown> = {}
    if (body.status !== undefined) updateData.status = body.status
    if (body.response !== undefined) updateData.response = body.response
    if (body.completedAt !== undefined) updateData.completedAt = new Date(body.completedAt)

    // Auto-set completedAt when status moves to COMPLETED
    if (body.status === "COMPLETED" && !body.completedAt) {
      updateData.completedAt = new Date()
    }

    // Lock, read, update and audit in one transaction: the change and its
    // audit row commit together, and the audited old values are exactly what
    // this write replaced even when two updates race.
    const dsar = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "DataSubjectRequest" WHERE id = ${id} AND "tenantId" = ${tenant.id} FOR UPDATE`)
      const existing = await tx.dataSubjectRequest.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true, completedAt: true },
      })
      if (!existing) return null

      // updateMany so tenantId can be included in the where clause
      await tx.dataSubjectRequest.updateMany({
        where: { id, tenantId: tenant.id },
        data: updateData,
      })

      const changed = AUDITED_FIELDS.filter((field) => field in updateData)
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.DSAR_UPDATED,
        entity: "DataSubjectRequest",
        entityId: id,
        oldValue: Object.fromEntries(changed.map((field) => [field, auditValue(existing[field])])),
        newValue: {
          ...Object.fromEntries(changed.map((field) => [field, auditValue(updateData[field])])),
          ...("response" in updateData && { responseChanged: true }),
        },
      }, tx)

      return tx.dataSubjectRequest.findFirst({
        where: { id, tenantId: tenant.id },
        include: {
          client: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      })
    })

    if (!dsar) {
      return NextResponse.json({ error: "DSAR not found" }, { status: 404 })
    }

    return NextResponse.json(dsar)
  })
}
