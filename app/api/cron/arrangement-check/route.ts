import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"
import { analyseArrangement } from "@/lib/collections/arrangement-tracker"
import { logAudit } from "@/lib/audit"
import { getDefaultTenantId } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenantId = await getDefaultTenantId()

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

  return NextResponse.json({ processed: arrangements.length, kept, completed, broken })
}
