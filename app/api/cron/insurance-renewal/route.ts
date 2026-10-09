import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"
import { SAST_TIME_ZONE } from "@/lib/utils"

export async function POST(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  try {
    const now = new Date()
    const in30Days = new Date(now)
    in30Days.setDate(in30Days.getDate() + 30)

    // ── Lapse automation ───────────────────────────────────────────────────────
    // Grace period: 30 days. Mark ACTIVE policies as LAPSED when a premium
    // payment is overdue by more than 30 days (or renewalDate passed by > 30 days).
    const GRACE_DAYS = 30
    const graceCutoff = new Date(now)
    graceCutoff.setDate(graceCutoff.getDate() - GRACE_DAYS)

    // Find active policies that have an OVERDUE premium payment whose due date
    // is older than the grace period.
    const lapseEligible = await prisma.insurancePolicy.findMany({
      where: {
        status: "ACTIVE",
        premiumPayments: {
          some: {
            status: "OVERDUE",
            dueDate: { lte: graceCutoff },
          },
        },
      },
      select: { id: true, tenantId: true, policyNumber: true },
    })

    const fallbackTenantId = await getDefaultTenantId()
    let lapsed = 0
    let lapseFailed = 0
    for (const lp of lapseEligible) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.insurancePolicy.update({
            where: { id: lp.id },
            data: { status: "LAPSED" },
          })

          // Task 7: clawback any PENDING/APPROVED commissions
          await tx.advisorCommission.updateMany({
            where: {
              policyId: lp.id,
              status: { in: ["PENDING", "APPROVED"] },
            },
            data: {
              status: "CLAWED_BACK",
              clawedBackAt: now,
              clawbackReason: "Policy lapsed due to overdue premium",
            },
          })
        })

        await prisma.auditLog.create({
          data: {
            tenantId: lp.tenantId || fallbackTenantId,
            action: "POLICY_LAPSED",
            entity: "InsurancePolicy",
            entityId: lp.id,
            oldValue: { status: "ACTIVE" },
            newValue: { status: "LAPSED", reason: "Premium overdue beyond grace period" },
          },
        })

        lapsed++
      } catch (err) {
        console.error("[insurance-renewal] policy update failed:", err)
        // Non-fatal: continue processing, but count it — a policy that keeps
        // failing to lapse never surfaces otherwise.
        lapseFailed++
      }
    }

    // ── Renewal notifications ──────────────────────────────────────────────────
    const policies = await prisma.insurancePolicy.findMany({
      where: {
        status: "ACTIVE",
        renewalDate: {
          gte: now,
          lte: in30Days,
        },
      },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        },
      },
    })

    let processed = 0
    let actioned = 0
    let actionFailed = 0

    for (const policy of policies) {
      processed++

      // Create a CrmActivity to flag the upcoming renewal for follow-up
      try {
        await prisma.crmActivity.create({
          data: {
            tenantId: policy.tenantId || fallbackTenantId,
            clientId: policy.clientId,
            type: "INSURANCE_OFFER",
            subject: `Insurance Renewal Due: ${policy.policyNumber}`,
            notes: `Policy ${policy.policyNumber} (${policy.type}) renews on ${policy.renewalDate.toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })}. Sum assured: R${Number(policy.sumAssured).toLocaleString("en-ZA")}. Contact client to arrange renewal.`,
            scheduledAt: policy.renewalDate,
            createdById: "SYSTEM",
          },
        })

        // Also log a NotificationLog entry
        await prisma.notificationLog.create({
          data: {
            tenantId: policy.tenantId || fallbackTenantId,
            clientId: policy.clientId,
            event: "insurance_renewal_due",
            channel: "system",
            status: "queued",
          },
        })

        actioned++
      } catch (err) {
        console.error("[insurance-renewal] commission update failed:", err)
        // Non-fatal: continue processing other policies, but count it — a
        // renewal notice that keeps failing to write never surfaces otherwise.
        actionFailed++
      }
    }

    // A hardcoded ok:true would hide a policy that keeps failing to lapse (so
    // it stays ACTIVE and collectible past its grace period) or a renewal
    // reminder that keeps failing to write (so nobody follows up before the
    // policy expires) from the systemd wrapper, which only fails the unit on
    // HTTP >= 400 and never parses this body.
    const ok = lapseFailed === 0 && actionFailed === 0
    return NextResponse.json(
      { ok, lapsed, lapseFailed, processed, renewed: actioned, actionFailed },
      { status: ok ? 200 : 503 },
    )
  } catch (error) {
    console.error("Insurance renewal cron failed:", error)
    return NextResponse.json({ error: "Cron job failed" }, { status: 500 })
  }
}
