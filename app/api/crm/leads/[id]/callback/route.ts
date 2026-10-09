import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

interface CallbackBody {
  callbackDate: string
  callbackNotes?: string
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
      const body: CallbackBody = await req.json()

      if (!body.callbackDate) {
        return NextResponse.json({ error: "callbackDate is required" }, { status: 422 })
      }

      const date = new Date(body.callbackDate)
      if (isNaN(date.getTime())) {
        return NextResponse.json({ error: "Invalid callbackDate" }, { status: 422 })
      }
      // A callback is a forward commitment — a past timestamp is nonsensical and
      // would land the lead as immediately-overdue. (The client's date input min
      // is only a hint and is UTC-derived, so this is the real guard.)
      if (date.getTime() <= Date.now()) {
        return NextResponse.json({ error: "Callback must be in the future" }, { status: 422 })
      }

      const existing = await prisma.lead.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      }
      // Scheduling a callback moves the lead to CONTACTED, so it must never run
      // on a closed lead: a CONVERTED lead would reappear as an open pipeline
      // lead while still attached to its client, and a LOST lead would lose its
      // terminal state — both corrupt the regulated CRM audit history. The UI
      // hides the tab for these, but a direct request must be refused too.
      if (existing.status === "CONVERTED" || existing.status === "LOST") {
        return NextResponse.json(
          { error: "Callbacks cannot be scheduled on a converted or lost lead." },
          { status: 409 }
        )
      }

      // CAS on the read status: if a concurrent convert/lost landed between the
      // read and here, the where-clause misses and we treat it as a conflict
      // rather than silently reopening the lead.
      const updated = await prisma.lead.updateMany({
        where: { id, tenantId: tenant.id, status: { notIn: ["CONVERTED", "LOST"] } },
        data: {
          callbackDate: date,
          callbackNotes: body.callbackNotes ?? null,
          status: "CONTACTED",
          // Stamp only a REAL stage change — re-scheduling a callback on an
          // already-CONTACTED lead must not reset its days-in-stage clock.
          ...(existing.status !== "CONTACTED" && { statusChangedAt: new Date() }),
        },
      })
      if (updated.count === 0) {
        return NextResponse.json(
          { error: "This lead's status changed — reload and try again." },
          { status: 409 }
        )
      }
      const lead = await prisma.lead.findFirst({ where: { id, tenantId: tenant.id } })
      if (!lead) {
        // Deleted in the window between the CAS write and this re-read.
        return NextResponse.json({ error: "This lead no longer exists." }, { status: 409 })
      }

      await logAudit({
        tenantId: tenant.id,
        action: "CALLBACK_SCHEDULED",
        entity: "Lead",
        entityId: id,
        userId: guard.user.id,
        newValue: { callbackDate: date.toISOString(), notes: body.callbackNotes },
      })

      return NextResponse.json(lead)
    } catch {
      return NextResponse.json({ error: "Failed to schedule callback" }, { status: 500 })
    }
  })
}
