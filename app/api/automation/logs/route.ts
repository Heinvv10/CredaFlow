import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = new URL(req.url)
    const ruleId = searchParams.get("ruleId")
    const result = searchParams.get("result")
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10), 500)

    const logs = await prisma.automationLog.findMany({
      where: {
        tenantId: tenant.id,
        ...(ruleId ? { ruleId } : {}),
        ...(result ? { result } : {}),
      },
      include: { rule: { select: { name: true, trigger: true, action: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    })

    return NextResponse.json(logs)
  })
}
