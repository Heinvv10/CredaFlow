import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import type { UserRole } from "@prisma/client"

const ADMIN_ROLES: UserRole[] = ["SUPER_ADMIN", "ADMIN", "LOAN_ADMIN"]

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!ADMIN_ROLES.includes(guard.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  return withTenantContext(req, async (tenant) => {
    const userId = req.nextUrl.searchParams.get("userId")
    const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "100")

    const logs = await prisma.loginLog.findMany({
      where: { tenantId: tenant.id, ...(userId ? { userId } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 500),
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    })

    return NextResponse.json({ logs })
  })
}
