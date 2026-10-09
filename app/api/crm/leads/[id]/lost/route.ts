import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"
import { VALID_LOST_REASONS, type LostReason } from "@/lib/lead-lost-reasons"

interface LostBody {
  reason: LostReason
  notes?: string
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
      const body: LostBody = await req.json()

      if (!body.reason || !VALID_LOST_REASONS.includes(body.reason)) {
        return NextResponse.json(
          { error: "Valid reason required", validReasons: VALID_LOST_REASONS },
          { status: 422 }
        )
      }

      const existing = await prisma.lead.findFirst({
        where: { id, tenantId: tenant.id },
        select: { status: true },
      })
      if (!existing) {
        return NextResponse.json({ error: "Lead not found" }, { status: 404 })
      }

      const lead = await prisma.lead.update({
        where: { id, tenantId: tenant.id },
        data: {
          status: "LOST",
          // Correcting the reason on an already-LOST lead is a no-op stage
          // change — it must not reset the days-in-stage clock.
          ...(existing.status !== "LOST" && { statusChangedAt: new Date() }),
          lostReason: body.reason,
          ...(body.notes ? { notes: body.notes } : {}),
        },
      })

      await logAudit({
        tenantId: tenant.id,
        action: "LEAD_LOST",
        entity: "Lead",
        entityId: id,
        userId: guard.user.id,
        newValue: { status: "LOST", lostReason: body.reason },
      })

      return NextResponse.json(lead)
    } catch {
      return NextResponse.json({ error: "Failed to mark lead as lost" }, { status: 500 })
    }
  })
}
