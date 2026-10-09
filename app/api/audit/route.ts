import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const url = req.nextUrl
    const entity = url.searchParams.get("entity")
    const userId = url.searchParams.get("userId")
    const from = url.searchParams.get("from")
    const to = url.searchParams.get("to")
    const page = parseInt(url.searchParams.get("page") ?? "1")
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200)
    const skip = (page - 1) * limit

    const where: Record<string, unknown> = { tenantId: tenant.id }
    if (entity) where.entity = entity
    if (userId) where.userId = userId
    if (from || to) {
      where.createdAt = {}
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from)
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to)
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { name: true, email: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ])

    return NextResponse.json({ logs, total, page, limit, pages: Math.ceil(total / limit) })
  })
}
