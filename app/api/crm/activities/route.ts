import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

export async function GET(req: Request) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { searchParams } = new URL(req.url)
      const leadId = searchParams.get("leadId")
      const clientId = searchParams.get("clientId")

      const activities = await prisma.crmActivity.findMany({
        where: {
          tenantId: tenant.id,
          ...(leadId ? { leadId } : {}),
          ...(clientId ? { clientId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      })

      return NextResponse.json(activities)
    } catch {
      return NextResponse.json({ error: "Failed to fetch activities" }, { status: 500 })
    }
  })
}

export async function POST(req: Request) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const data = await req.json()

      if (data.leadId) {
        const lead = await prisma.lead.findFirst({
          where: { id: data.leadId, tenantId: tenant.id },
          select: { id: true },
        })
        if (!lead) {
          return NextResponse.json({ error: "Lead not found" }, { status: 404 })
        }
      }
      if (data.clientId) {
        const client = await prisma.client.findFirst({
          where: { id: data.clientId, tenantId: tenant.id },
          select: { id: true },
        })
        if (!client) {
          return NextResponse.json({ error: "Client not found" }, { status: 404 })
        }
      }

      const activity = await prisma.crmActivity.create({
        data: {
          tenantId: tenant.id,
          leadId: data.leadId || null,
          clientId: data.clientId || null,
          type: data.type,
          subject: data.subject,
          notes: data.notes || null,
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
          createdById: guard.user.id!,
        },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "CRM_ACTIVITY_CREATED",
        entity: "CrmActivity",
        entityId: activity.id,
        newValue: {
          type: activity.type,
          subject: activity.subject,
          leadId: activity.leadId,
          clientId: activity.clientId,
        },
      })

      return NextResponse.json(activity, { status: 201 })
    } catch {
      return NextResponse.json({ error: "Failed to create activity" }, { status: 500 })
    }
  })
}
