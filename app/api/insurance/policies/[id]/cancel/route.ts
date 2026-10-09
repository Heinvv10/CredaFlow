import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { logAudit } from "@/lib/audit"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const body = await req.json() as { reason: string; cancellationDate: string }

      if (!body.reason?.trim()) {
        return NextResponse.json({ error: "reason is required" }, { status: 400 })
      }
      if (!body.cancellationDate) {
        return NextResponse.json({ error: "cancellationDate is required" }, { status: 400 })
      }

      const policy = await prisma.insurancePolicy.findFirst({ where: { id, tenantId: tenant.id } })
      if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })
      if (policy.status === "CANCELLED") {
        return NextResponse.json({ error: "Policy is already cancelled" }, { status: 400 })
      }

      const cancellationDate = new Date(body.cancellationDate)
      const startDate = new Date(policy.startDate)
      const renewalDate = new Date(policy.renewalDate)

      // Pro-rata refund: (daysRemaining / totalPolicyDays) * annualPremium
      const totalPolicyDays = Math.max(
        1,
        Math.round((renewalDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
      )
      const daysRemaining = Math.max(
        0,
        Math.round((renewalDate.getTime() - cancellationDate.getTime()) / (1000 * 60 * 60 * 24))
      )
      const annualPremium = Number(policy.premiumAmount) * 12
      const refundAmount = parseFloat(((daysRemaining / totalPolicyDays) * annualPremium).toFixed(2))

      const userId = guard.user.id
      const userEmail = guard.user.email

      // Transaction: cancel policy, clawback commissions
      await prisma.$transaction(async (tx) => {
        await tx.insurancePolicy.update({
          where: { id, tenantId: tenant.id },
          data: { status: "CANCELLED" },
        })

        // Task 7: clawback any PENDING/APPROVED commissions
        await tx.advisorCommission.updateMany({
          where: {
            policyId: id,
            tenantId: tenant.id,
            status: { in: ["PENDING", "APPROVED"] },
          },
          data: {
            status: "CLAWED_BACK",
            clawedBackAt: new Date(),
            clawbackReason: "Policy cancelled",
          },
        })
      })

      await logAudit({
        tenantId: tenant.id,
        userId,
        userEmail,
        action: "POLICY_CANCELLED",
        entity: "InsurancePolicy",
        entityId: id,
        oldValue: { status: policy.status },
        newValue: {
          status: "CANCELLED",
          reason: body.reason,
          cancellationDate: cancellationDate.toISOString(),
          refundAmount,
        },
      })

      return NextResponse.json({ refundAmount, cancellationDate: cancellationDate.toISOString(), reason: body.reason })
    })
  } catch (error) {
    console.error("Policy cancellation error:", error)
    return NextResponse.json({ error: "Failed to cancel policy" }, { status: 500 })
  }
}
