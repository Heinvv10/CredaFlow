import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { Prisma } from "@prisma/client"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const rule = await prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.tenantId !== tenant.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const body = await req.json() as {
      enabled?: boolean; name?: string; description?: string
      condition?: Prisma.InputJsonValue; actionConfig?: Prisma.InputJsonValue
    }

    const updated = await prisma.automationRule.update({
      where: { id, tenantId: tenant.id },
      data: {
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.condition !== undefined ? { condition: body.condition } : {}),
        ...(body.actionConfig !== undefined ? { actionConfig: body.actionConfig } : {}),
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "AUTOMATION_RULE_UPDATED",
      entity: "AutomationRule",
      entityId: id,
      oldValue: { enabled: rule.enabled, name: rule.name },
      newValue: { enabled: updated.enabled, name: updated.name },
    })

    return NextResponse.json(updated)
  })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const rule = await prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.tenantId !== tenant.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (rule.isBuiltIn) {
      return NextResponse.json({ error: "Built-in rules cannot be deleted — disable them instead" }, { status: 400 })
    }

    await prisma.automationRule.delete({ where: { id, tenantId: tenant.id } })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "AUTOMATION_RULE_DELETED",
      entity: "AutomationRule",
      entityId: id,
      oldValue: { name: rule.name, trigger: rule.trigger, action: rule.action },
    })

    return NextResponse.json({ ok: true })
  })
}
