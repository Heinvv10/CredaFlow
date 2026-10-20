import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { analyseArrangement } from "@/lib/collections/arrangement-tracker"
import { logAudit } from "@/lib/audit"
import { sweepActiveTenants } from "@/lib/collections/tenant-sweep"

export interface ArrangementCheckCounts {
  processed: number
  kept: number
  completed: number
  broken: number
}

export interface ArrangementCheckResult extends ArrangementCheckCounts {
  tenants: number
  failedTenants: number
}

/**
 * Settles every ACTIVE tenant's active payment arrangements (kept / broken /
 * completed). The dunning holds read the result (a BROKEN arrangement stops
 * holding its loan out of reminders), so a tenant that is not the deployment's
 * default must be settled too: each ACTIVE tenant runs in its own frame.
 */
export async function runArrangementCheck(): Promise<ArrangementCheckResult> {
  const outcomes = await sweepActiveTenants("arrangement-check", (tenant) => checkTenantArrangements(tenant.id))
  const total: ArrangementCheckResult = { processed: 0, kept: 0, completed: 0, broken: 0, tenants: outcomes.length, failedTenants: 0 }
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.failedTenants++
      continue
    }
    total.processed += outcome.value.processed
    total.kept += outcome.value.kept
    total.completed += outcome.value.completed
    total.broken += outcome.value.broken
  }
  return total
}

async function checkTenantArrangements(tenantId: string): Promise<ArrangementCheckCounts> {
  const arrangements = await prisma.paymentArrangement.findMany({
    where: { tenantId, status: "ACTIVE" },
    select: {
      loanId: true,
      agreedAmount: true,
      frequency: true,
      startDate: true,
      endDate: true,
    },
  })

  let kept = 0, broken = 0, completed = 0

  await Promise.all(
    arrangements.map(async (arr) => {
      const payments = await prisma.payment.findMany({
        where: {
          tenantId,
          loanId: arr.loanId,
          reversed: false,
          allocationStatus: "ALLOCATED",
          // A waived balance is not an arrangement instalment paid.
          ...CASH_RECEIPTS,
        },
        select: { id: true, amount: true, receivedAt: true },
        orderBy: { receivedAt: "asc" },
      })

      const analysis = analyseArrangement(
        { agreedAmount: arr.agreedAmount, frequency: arr.frequency, startDate: arr.startDate, endDate: arr.endDate },
        payments
      )

      const newStatus =
        analysis.overallStatus === "COMPLETED" && analysis.complianceRate >= 90 ? "KEPT"
        : analysis.overallStatus === "COMPLETED" ? "COMPLETED"
        : analysis.overallStatus === "BROKEN" ? "BROKEN"
        : null

      if (newStatus) {
        try {
          await prisma.paymentArrangement.updateMany({
            where: { loanId: arr.loanId, tenantId },
            data: { status: newStatus },
          })

          if (newStatus === "BROKEN") {
            await prisma.loanNote.create({
              data: { tenantId, loanId: arr.loanId, type: "arrangement_broken", note: "Payment arrangement marked BROKEN by nightly evaluation", createdBy: "system" },
            }).catch((e: unknown) => console.error(`[arrangement-check] Note creation failed for ${arr.loanId}:`, e))
          }

          logAudit({
            tenantId,
            action: "ARRANGEMENT_STATUS_CHANGED",
            entity: "PaymentArrangement",
            entityId: arr.loanId,
            oldValue: { status: "ACTIVE" },
            newValue: { status: newStatus },
          }).catch((e: unknown) => console.error(`[arrangement-check] Audit failed for ${arr.loanId}:`, e))

          if (newStatus === "KEPT") kept++
          else if (newStatus === "BROKEN") broken++
          else completed++
        } catch (e: unknown) {
          console.error(`[arrangement-check] Update failed for ${arr.loanId}:`, e)
        }
      }
    })
  )

  return { processed: arrangements.length, kept, completed, broken }
}
