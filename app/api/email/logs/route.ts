import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = new URL(req.url)
    const category = searchParams.get("category")
    const referenceId = searchParams.get("referenceId")

    const logs = await prisma.emailLog.findMany({
      where: {
        tenantId: tenant.id,
        ...(category ? { category } : {}),
        ...(referenceId ? { referenceId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return NextResponse.json(logs)
  })
}
