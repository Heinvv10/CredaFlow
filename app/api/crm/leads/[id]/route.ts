import { withInputStaff } from "@/lib/applications/input-staff"
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { isAssignableStaff } from "@/lib/crm/staff"
import { VALID_LOST_REASONS } from "@/lib/lead-lost-reasons"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params
      const lead = await prisma.lead.findUnique({
        where: { id, tenantId: tenant.id },
        include: {
          activities: { orderBy: { createdAt: "desc" } },
        },
      })

      if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      return NextResponse.json(lead)
    } catch {
      return NextResponse.json({ error: "Failed to fetch lead" }, { status: 500 })
    }
  })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params
      const data = await req.json()

      const existing = await prisma.lead.findFirst({
        where: { id, tenantId: tenant.id },
        // requestedAmount/declaredIncome are audited below because they are no
        // longer just CRM scoring inputs: requestedAmount is the fact the lead
        // outreach lawful basis rests on (lib/crm/lead-outreach-eligibility.ts
        // — "did this person actually ask us for credit?"). Whoever sets it
        // creates that basis, so who set it, when, and from what has to be on
        // the record.
        select: { status: true, assignedToId: true, requestedAmount: true, declaredIncome: true, employmentType: true, inputStaffIds: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      }

      if (data.status === "CONVERTED") {
        return NextResponse.json(
          { error: "Leads can only be converted via the convert flow (POST /api/crm/leads/[id]/convert), not a direct status update." },
          { status: 400 }
        )
      }
      if (existing.status === "CONVERTED" && data.status !== undefined && data.status !== "CONVERTED") {
        return NextResponse.json(
          { error: "Converted leads cannot have their status changed directly. Stranded leads (no client attached) can be reset from the convert page." },
          { status: 400 }
        )
      }
      if (data.status === "LOST" && !VALID_LOST_REASONS.includes(data.lostReason)) {
        return NextResponse.json(
          { error: "A valid lostReason is required to mark a lead as LOST. Use PATCH /api/crm/leads/[id]/lost.", validReasons: VALID_LOST_REASONS },
          { status: 400 }
        )
      }
      // Money fields are integer cents and never negative — the modal enforces
      // this client-side (lib/crm/lead-edit-form.ts), but a direct request must
      // not be able to persist a negative or fractional amount that then feeds
      // scoring, the outreach lawful-basis check, and reporting.
      for (const field of ["requestedAmount", "declaredIncome"] as const) {
        const v = data[field]
        if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0)) {
          return NextResponse.json(
            { error: `${field} must be a whole, non-negative amount in cents.` },
            { status: 400 }
          )
        }
      }
      // assignedToId has no FK and User is not tenant-scoped, so an unchecked
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

      const lead = await prisma.lead.update({
        where: { id, tenantId: tenant.id },
        data: {
          ...(data.firstName !== undefined && { firstName: data.firstName }),
          ...(data.lastName !== undefined && { lastName: data.lastName }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.source !== undefined && { source: data.source }),
          ...(data.status !== undefined && { status: data.status }),
          // Stamp only a REAL stage change — a resend of the current status
          // must not reset the days-in-stage clock.
          ...(data.status !== undefined && data.status !== existing.status && { statusChangedAt: new Date() }),
          ...(data.lostReason !== undefined && { lostReason: data.lostReason }),
          // `|| null` matches POST /api/crm/leads: an empty string means
          // "unassign", and storing "" instead would read as assigned to the
          // `assignedToId: { not: null }` filters (stale-leads-alert cron, the
          // advisor report groupBy) while rendering as Unassigned in the UI.
          ...(data.assignedToId !== undefined && { assignedToId: data.assignedToId || null }),
          ...(data.notes !== undefined && { notes: data.notes }),
          ...(data.tags !== undefined && { tags: data.tags }),
          ...(data.employmentType !== undefined && { employmentType: data.employmentType }),
          // A figure a decision fact reads (income, employment), entered or changed on the lead: whoever did cannot later
          // disburse an engine approval of the client's application (lib/applications/input-staff.ts).
          ...(((data.declaredIncome !== undefined && data.declaredIncome !== existing.declaredIncome)
            || (data.employmentType !== undefined && data.employmentType !== existing.employmentType))
            && { inputStaffIds: withInputStaff(existing.inputStaffIds, guard.user.id) }),
          ...(data.declaredIncome !== undefined && { declaredIncome: data.declaredIncome }),
          ...(data.requestedAmount !== undefined && { requestedAmount: data.requestedAmount }),
          ...(data.referredBy !== undefined && { referredBy: data.referredBy }),
        },
      })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "LEAD_UPDATED",
        entity: "Lead",
        entityId: id,
        oldValue: {
          status: existing.status,
          assignedToId: existing.assignedToId,
          requestedAmount: existing.requestedAmount,
          declaredIncome: existing.declaredIncome,
        },
        newValue: {
          status: lead.status,
          assignedToId: lead.assignedToId,
          requestedAmount: lead.requestedAmount,
          declaredIncome: lead.declaredIncome,
        },
      })

      return NextResponse.json(lead)
    } catch {
      return NextResponse.json({ error: "Failed to update lead" }, { status: 500 })
    }
  })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params
      const existing = await prisma.lead.findFirst({
        where: { id, tenantId: tenant.id },
        select: { firstName: true, lastName: true, phone: true, status: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      }

      await prisma.lead.delete({ where: { id, tenantId: tenant.id } })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "LEAD_DELETED",
        entity: "Lead",
        entityId: id,
        oldValue: {
          name: `${existing.firstName} ${existing.lastName}`,
          phone: existing.phone,
          status: existing.status,
        },
      })

      return NextResponse.json({ success: true })
    } catch {
      return NextResponse.json({ error: "Failed to delete lead" }, { status: 500 })
    }
  })
}
