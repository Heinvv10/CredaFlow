import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { prisma } from "@/lib/prisma"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { reverseReferralCommissionForLoan } from "@/lib/referral-agents/commission"
import { sastStartOfDay } from "@/lib/date/sast"
import { sweepActiveTenants } from "@/lib/ops/tenant-sweep"
import { cronDoneToday, recordCronDone } from "@/lib/ops/cron-run-claim"

export interface DpdUpdateCounts {
  processed: number
  updated: number
  skipped: number
}

/** A failed tenant carries no cause: it is in the server log, not the response. */
export type DpdUpdateTenantResult = { tenantId: string } & (DpdUpdateCounts | { error: "failed; see the server log" })

export interface DpdUpdateResult extends DpdUpdateCounts {
  perTenant: DpdUpdateTenantResult[]
  failedTenants: number
}

/**
 * Nightly reconcile of daysInArrears + arrearsAmount for the collectible book
 * of EVERY ACTIVE tenant, each in its own tenant frame, derived from the
 * repayment schedule via the SAME recomputeLoanBalances helper the payment
 * paths use. This keeps exactly one definition of DPD/arrears across the
 * system: DPD = days since the earliest overdue unpaid instalment's due date;
 * arrears = sum of overdue unpaid instalment balances. Auto-promotes to
 * DEFAULTED at 90+ DPD.
 *
 * Runs before escalations and reminders, which read what it writes
 * (lib/registry/cron-jobs/091-dunning.ts).
 */
export async function runDpdUpdate(): Promise<DpdUpdateResult> {
  const outcomes = await sweepActiveTenants("dpd-update", (tenant) => updateTenantDpd(tenant.id))
  const total: DpdUpdateResult = { processed: 0, updated: 0, skipped: 0, perTenant: [], failedTenants: 0 }
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.failedTenants++
      total.perTenant.push({ tenantId: outcome.tenant.id, error: "failed; see the server log" })
      continue
    }
    total.processed += outcome.value.processed
    total.updated += outcome.value.updated
    total.skipped += outcome.value.skipped
    total.perTenant.push({ tenantId: outcome.tenant.id, ...outcome.value })
  }
  return total
}

/** Today's "dpd-update done" marker for one tenant (a DONE CronRunClaim row). */
const doneMarker = (tenantId: string) => `dpd-update:${tenantId}`

/**
 * Escalations and reminders act on the DPD and arrears this job writes, so each
 * makes sure it has run for its tenant today before it sends anything, and runs
 * it first if not (it is idempotent and a few seconds a tenant). The
 * alternative, logging and proceeding, would escalate and remind on yesterday's
 * figures: a borrower who paid yesterday could still be defaulted and sent a
 * notice. If it fails here the tenant's run fails rather than send on stale
 * data: that is counted in the response's `failedTenants`, which makes the
 * scheduler mark the run FAILED, so the +30 and +60 minute firings of escalations
 * and reminders try the tenant again.
 */
export async function ensureDpdCurrent(tenantId: string): Promise<void> {
  if (await cronDoneToday(doneMarker(tenantId))) return
  await updateTenantDpd(tenantId)
}

export async function updateTenantDpd(tenantId: string): Promise<DpdUpdateCounts> {
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

  await recordCronDone(doneMarker(tenantId))
  return { processed: loans.length, updated, skipped }
}
