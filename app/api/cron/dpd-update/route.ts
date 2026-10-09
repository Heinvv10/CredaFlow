import { NextRequest, NextResponse } from "next/server"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { verifyCronSecret } from "@/lib/cron-auth"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { reverseReferralCommissionForLoan } from "@/lib/referral-agents/commission"
import { sastStartOfDay } from "@/lib/date/sast"

/**
 * DPD Update Cron — nightly reconcile of daysInArrears + arrearsAmount for all
 * active/defaulted loans, derived from the repayment schedule via the SAME
 * recomputeLoanBalances helper the payment paths use. This keeps exactly one
 * definition of DPD/arrears across the system (audit F-15): DPD = days since the
 * earliest overdue unpaid instalment's due date; arrears = sum of overdue unpaid
 * instalment balances. Auto-promotes to DEFAULTED at 90+ DPD.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenantId = await getDefaultTenantId()

  // SAST midnight, not the container's. This ran `setHours(0, 0, 0, 0)` on a
  // UTC container, so the DPD day rolled over at 02:00 SAST.
  const today = sastStartOfDay(new Date())

  const loans = await prisma.loan.findMany({
    // Refresh the whole collectible book, not just ACTIVE+DEFAULTED. Reporting
    // (PAR bands, arrears totals, the NCR return) reads daysInArrears and
    // arrearsAmount for every loan in the book, so a status this job skips is a
    // loan whose DPD band is frozen at whatever it carried when it got there —
    // real principal in a fictional band.
    //
    // The TRANSITIONS below stay on their original population. Widening the
    // read is a data-freshness fix; widening the writes would be a behaviour
    // change, and promoting a PENDING_WRITE_OFF loan to DEFAULTED would pull it
    // straight back out of the write-off approval queue.
    where: collectibleLoanWhere(tenantId),
    select: {
      id: true,
      status: true,
      principal: true,
      daysInArrears: true,
      arrearsAmount: true,
      repaymentSchedule: {
        orderBy: { dueDate: "asc" },
        select: {
          dueDate: true, principalDue: true, interestDue: true,
          feesDue: true, totalDue: true, totalPaid: true,
        },
      },
    },
  })

  let updated = 0
  let skipped = 0

  for (const loan of loans) {
    const { daysInArrears: newDpd, arrearsAmount: newArrears } =
      recomputeLoanBalances(loan.principal, loan.repaymentSchedule, today)

    // Skip if nothing changed
    if (loan.daysInArrears === newDpd && loan.arrearsAmount === newArrears) {
      skipped++
      continue
    }

    await prisma.loan.updateMany({
      where: { id: loan.id, tenantId },
      data: {
        daysInArrears: newDpd,
        arrearsAmount: newArrears,
        // Auto-promote to DEFAULTED at 90+ DPD — ACTIVE only. A
        // PENDING_WRITE_OFF loan crossing 90 must keep its status, or the
        // nightly job silently cancels a pending write-off request; a
        // RESTRUCTURED one must not be re-defaulted behind the arrangement.
        ...(newDpd >= 90 && loan.status === "ACTIVE" && { status: "DEFAULTED" }),
      },
    })

    // Clawback is idempotent (only touches PENDING/PAYABLE), so run it whenever the
    // loan is at/over the default threshold — it re-runs harmlessly each night until
    // the events are REVERSED, self-healing after any transient failure.
    // Clawback is gated to the statuses this job already covered, so widening
    // the read above changes no money. Whether a loan that crosses 90 DPD while
    // parked for write-off should also have its agent commission clawed back is
    // a ledger policy question, not a reporting one — deliberately unanswered
    // here rather than answered by accident.
    if (newDpd >= 90 && (loan.status === "ACTIVE" || loan.status === "DEFAULTED")) {
      await reverseReferralCommissionForLoan(prisma, { tenantId, loanId: loan.id })
    }

    updated++
  }

  return NextResponse.json({
    ok: true,
    processed: loans.length,
    updated,
    skipped,
    runAt: new Date().toISOString(),
  })
}
