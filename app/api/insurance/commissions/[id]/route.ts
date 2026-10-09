import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"

/**
 * The state this transition replaced. Recorded so an auditor can see the
 * commission's prior standing without reconstructing it from adjacent rows.
 */
function priorState(commission: {
  status: string
  amount: unknown
  period: string
  advisorId: string
  policyId: string
}) {
  return {
    status: commission.status,
    amount: Number(commission.amount),
    period: commission.period,
    advisorId: commission.advisorId,
    policyId: commission.policyId,
  }
}

// PATCH /api/insurance/commissions/[id] — approve, pay, or claw back
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const body = await req.json() as {
        action: "approve" | "pay" | "claw_back"
        clawbackReason?: string
      }

      const commission = await prisma.advisorCommission.findFirst({ where: { id, tenantId: tenant.id } })
      if (!commission) return NextResponse.json({ error: "Not found" }, { status: 404 })

      if (body.action === "approve") {
        const updated = await prisma.advisorCommission.update({
          where: { id, tenantId: tenant.id },
          data: { status: "APPROVED" },
        })

        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_COMMISSION_APPROVED,
          entity: "AdvisorCommission",
          entityId: id,
          oldValue: priorState(commission),
          // The persisted row, not the parsed input — the audit trail is
          // evidence of what the database holds.
          newValue: updated,
        })

        return NextResponse.json(updated)
      }

      if (body.action === "pay") {
        if (commission.status !== "APPROVED") {
          return NextResponse.json({ error: "Commission must be approved before marking as paid" }, { status: 400 })
        }
        const updated = await prisma.advisorCommission.update({
          where: { id, tenantId: tenant.id },
          data: { status: "PAID", paidAt: new Date() },
        })

        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_COMMISSION_PAID,
          entity: "AdvisorCommission",
          entityId: id,
          oldValue: priorState(commission),
          newValue: updated,
        })

        return NextResponse.json(updated)
      }

      if (body.action === "claw_back") {
        if (!body.clawbackReason) {
          return NextResponse.json({ error: "clawbackReason is required" }, { status: 400 })
        }
        const updated = await prisma.advisorCommission.update({
          where: { id, tenantId: tenant.id },
          data: { status: "CLAWED_BACK", clawedBackAt: new Date(), clawbackReason: body.clawbackReason },
        })

        // The clawback reason is free text a human typed and is the ONLY record
        // of why the reversal was justified, so it is preserved here as the
        // database stored it.
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_COMMISSION_CLAWED_BACK,
          entity: "AdvisorCommission",
          entityId: id,
          oldValue: priorState(commission),
          newValue: updated,
        })

        return NextResponse.json(updated)
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
    })
  } catch {
    return NextResponse.json({ error: "Failed to update commission" }, { status: 500 })
  }
}
