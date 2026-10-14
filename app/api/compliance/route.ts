import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const records = await prisma.complianceRecord.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          referenceId: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          data: true,
        },
      })
      // ComplianceRecord.data may contain statutory snapshots with names, ID
      // numbers, addresses, recipient details, balances and private storage
      // paths. The generic READONLY listing needs only lifecycle state.
      return NextResponse.json(records.map((record) => {
        const lifecycle = record.data
          && typeof record.data === "object"
          && !Array.isArray(record.data)
          && typeof (record.data as { lifecycle?: unknown }).lifecycle === "string"
          ? (record.data as { lifecycle: string }).lifecycle
          : undefined
        return {
          id: record.id,
          type: record.type,
          status: record.status,
          referenceId: record.referenceId,
          dueDate: record.dueDate,
          completedAt: record.completedAt,
          createdAt: record.createdAt,
          data: lifecycle ? { lifecycle } : {},
        }
      }))
    } catch {
      return NextResponse.json({ error: "Failed to fetch compliance records" }, { status: 500 })
    }
  })
}
