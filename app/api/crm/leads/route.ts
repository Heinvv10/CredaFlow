import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { provisionContactForLead } from "@/lib/contact/provision"
import { isAssignableStaff } from "@/lib/crm/staff"
import { LeadStatus, LeadSource } from "@prisma/client"

const VALID_LEAD_STATUS = new Set<string>(Object.values(LeadStatus))
const VALID_LEAD_SOURCE = new Set<string>(Object.values(LeadSource))

export async function GET(req: Request) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { searchParams } = new URL(req.url)
      const status = searchParams.get("status")
      const source = searchParams.get("source")
      const assignedToId = searchParams.get("assignedToId")

      if (status && !VALID_LEAD_STATUS.has(status)) {
        return NextResponse.json({ error: "Invalid status filter" }, { status: 400 })
      }
      if (source && !VALID_LEAD_SOURCE.has(source)) {
        return NextResponse.json({ error: "Invalid source filter" }, { status: 400 })
      }

      const leads = await prisma.lead.findMany({
        where: {
          tenantId: tenant.id,
          ...(status ? { status: status as LeadStatus } : {}),
          ...(source ? { source: source as LeadSource } : {}),
          ...(assignedToId ? { assignedToId } : {}),
        },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { activities: true } },
        },
      })

      const now = Date.now()
      const enriched = leads.map((l) => ({
        ...l,
        ageDays: Math.floor((now - new Date(l.createdAt).getTime()) / 86400000),
        // statusChangedAt, not updatedAt: any field edit bumps updatedAt, which
        // made this lie about how long the lead has sat in its current stage.
        stageAgeDays: Math.floor((now - new Date(l.statusChangedAt).getTime()) / 86400000),
      }))

      return NextResponse.json(enriched)
    } catch (err) {
      console.error("Failed to fetch leads:", err)
      return NextResponse.json({ error: "Failed to fetch leads" }, { status: 500 })
    }
  })
}

export async function POST(req: Request) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const data = await req.json()

      // assignedToId has no FK and User is not tenant-scoped — an unchecked
      // body value would persist another tenant's user (or arbitrary text).
      // Same rule the reassign action applies — see lib/crm/staff.ts.
      if (
        data.assignedToId &&
        !(await isAssignableStaff(prisma.user, { tenantId: tenant.id, userId: data.assignedToId }))
      ) {
        return NextResponse.json(
          { error: "That staff member can no longer be assigned leads" },
          { status: 400 }
        )
      }

      const lead = await prisma.lead.create({
        data: {
          tenantId: tenant.id,
          firstName: data.firstName,
          lastName: data.lastName,
          email: data.email || null,
          phone: data.phone,
          source: data.source ?? "MANUAL",
          status: "NEW",
          assignedToId: data.assignedToId || null,
          notes: data.notes || null,
          tags: data.tags ?? [],
        },
      })

      // Provision the lead's unified Contact + ContactIdentity rows (F-23) so
      // it enters the Phase-9 directory and the channel-keyed messaging
      // eligibility lookup (canSend). Done best-effort AFTER the lead commits:
      // a lead must never fail to create because of directory provisioning. In
      // the rare case where a concurrent lead-create has already claimed the
      // same phone/email, the ContactIdentity unique violation aborts this
      // inner transaction (Postgres poisons a tx on a failed statement) — we
      // log and move on, leaving the lead intact for the Phase-9 backfill/merge
      // flow to reconcile. The provision helper itself skips channels already
      // claimed by another Contact, so this catch only fires on a true race.
      try {
        await prisma.$transaction((tx) =>
          provisionContactForLead(tx, {
            tenantId: tenant.id,
            leadId: lead.id,
            firstName: lead.firstName,
            lastName: lead.lastName,
            email: lead.email,
            phone: lead.phone,
          }),
        )
      } catch (err) {
        console.warn(
          `[crm/leads] Contact provisioning failed for lead ${lead.id}; directory backfill will reconcile.`,
          err,
        )
      }

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "LEAD_CREATED",
        entity: "Lead",
        entityId: lead.id,
        newValue: {
          name: `${lead.firstName} ${lead.lastName}`,
          phone: lead.phone,
          source: lead.source,
          assignedToId: lead.assignedToId,
        },
      })

      return NextResponse.json(lead, { status: 201 })
    } catch {
      return NextResponse.json({ error: "Failed to create lead" }, { status: 500 })
    }
  })
}
