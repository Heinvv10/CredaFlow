import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const entityId = req.nextUrl.searchParams.get("entityId")
      const pauses = await prisma.automationPause.findMany({
        where: {
          tenantId: tenant.id,
          ...(entityId ? { entityId } : {}),
        },
        include: { rule: { select: { name: true, trigger: true, action: true } } },
        orderBy: { createdAt: "desc" },
      })

      return NextResponse.json(pauses)
    })
  } catch (err) {
    console.error("Failed to fetch pauses:", err)
    return NextResponse.json({ error: "Failed to fetch pauses" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const { ruleId, entityType, entityId } = await req.json() as {
        ruleId?: string; entityType?: string; entityId?: string
      }
      if (!ruleId || !entityType || !entityId) {
        return NextResponse.json({ error: "ruleId, entityType, and entityId are required" }, { status: 400 })
      }

      const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, tenantId: tenant.id }, select: { id: true } })
      if (!rule) return NextResponse.json({ error: "Rule not found" }, { status: 404 })

      const existing = await prisma.automationPause.findUnique({
        where: { ruleId_entityId: { ruleId, entityId } },
      })
      if (existing) return NextResponse.json(existing, { status: 200 })

      const pause = await prisma.automationPause.create({
        data: { tenantId: tenant.id, ruleId, entityType, entityId, createdById: guard.user.id },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "AUTOMATION_PAUSE_CREATED",
        entity: "AutomationPause",
        entityId: pause.id,
        newValue: { ruleId, entityType, entityId },
      })

      return NextResponse.json(pause, { status: 201 })
    })
  } catch (err) {
    console.error("Failed to create pause:", err)
    return NextResponse.json({ error: "Failed to create pause" }, { status: 500 })
  }
}
