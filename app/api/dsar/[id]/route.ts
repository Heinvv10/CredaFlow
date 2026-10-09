import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import type { DsarStatus } from "@prisma/client"

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

    // Switch to updateMany so tenantId can be included in the where clause
    const result = await prisma.dataSubjectRequest.updateMany({
      where: { id, tenantId: tenant.id },
      data: updateData,
    })

    if (result.count === 0) {
      return NextResponse.json({ error: "DSAR not found" }, { status: 404 })
    }

    const dsar = await prisma.dataSubjectRequest.findFirst({
      where: { id, tenantId: tenant.id },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    })

    return NextResponse.json(dsar)
  })
}
