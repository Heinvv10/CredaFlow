import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { Prisma, AutomationTrigger, AutomationAction } from "@prisma/client"

const VALID_TRIGGERS = new Set<string>(Object.values(AutomationTrigger))
const VALID_ACTIONS = new Set<string>(Object.values(AutomationAction))

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const rules = await prisma.automationRule.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ trigger: "asc" }, { createdAt: "asc" }],
    })

    return NextResponse.json(rules)
  })
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = await req.json() as {
      name: string; description?: string; trigger: string
      condition: Prisma.InputJsonValue; action: string; actionConfig?: Prisma.InputJsonValue
    }

    if (!body.name || !body.trigger || !body.action) {
      return NextResponse.json({ error: "name, trigger, and action are required" }, { status: 400 })
    }
    if (!VALID_TRIGGERS.has(body.trigger)) {
      return NextResponse.json({ error: "Invalid trigger" }, { status: 400 })
    }
    if (!VALID_ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
    }

    if (body.action === "SEND_WA") {
      return NextResponse.json({
        error: "WhatsApp reminders are sent by the reminders cron, not by automation rules.",
      }, { status: 422 })
    }

    const rule = await prisma.automationRule.create({
      data: {
        tenantId: tenant.id,
        name: body.name,
        description: body.description ?? null,
        trigger: body.trigger as AutomationTrigger,
        condition: body.condition ?? {},
        action: body.action as AutomationAction,
        actionConfig: body.actionConfig ?? {},
      },
    })

    return NextResponse.json(rule, { status: 201 })
  })
}
