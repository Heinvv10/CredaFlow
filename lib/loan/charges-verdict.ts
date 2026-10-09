import { allocateReceipts } from "@/lib/loan/balances"
import { chargesOutstandingTotal } from "@/lib/loan/charges-replay"
import { ChargesError } from "@/lib/loan/charges-error"
import type { DefaultChargeResult } from "@/lib/loan/default-charges"

// What syncLoanCharges decides from a replay, as pure functions, so the
// back-fill dry run predicts exactly what --apply's sweep will do.

/** Why the sync refuses to persist this replay, or null. */
export function syncRefusal(
  loanId: string,
  loan: { status: string; writeOffAt: Date | null; closedAt: Date | null; defaultChargesExempt: boolean },
  result: DefaultChargeResult,
): string | null {
  // A closed status without its date cannot be bounded: refuse rather than
  // charge it as if it were open.
  const missingDate = loan.status === "WRITTEN_OFF" && !loan.writeOffAt ? "writeOffAt"
    : (loan.status === "COMPLETED" || loan.status === "CANCELLED") && !loan.closedAt ? "closedAt"
      : null
  if (missingDate) return `Loan ${loanId} is ${loan.status} with no ${missingDate}; refusing to derive its charges`
  // Every receipt path bounds a receipt by the charge-inclusive settlement, so
  // money beyond everything owed means a writer disagrees with the replay.
  // Refuse rather than persist a ledger that cannot balance.
  if (result.unallocated > 0) {
    return `Default-charges replay left ${result.unallocated} cents of live receipts unallocated on loan ${loanId}`
      + (loan.defaultChargesExempt
        ? " — it is exempt and its client paid charges: lift the exemption, run --apply, then exempt it again, which refunds them"
        : "")
  }
  return null
}

/** The schedule and every charge are paid: the loan is (or stays) COMPLETED. */
export function replaySettled(schedule: Array<{ totalDue: number }>, result: DefaultChargeResult): boolean {
  const scheduleTotal = schedule.reduce((sum, row) => sum + row.totalDue, 0)
  return scheduleTotal > 0 && result.scheduleAllocated >= scheduleTotal && chargesOutstandingTotal(result) === 0
}

/** Changes to money already booked that a normal sync may not make on its own. */
export type GuardedChange = "lowers_total_paid" | "reopens"

export function guardedChanges(
  loan: { status: string; totalPaid: number; repaymentSchedule: Array<{ totalDue: number }> },
  result: DefaultChargeResult,
): GuardedChange[] {
  const changes: GuardedChange[] = []
  if (result.scheduleAllocated < loan.totalPaid) changes.push("lowers_total_paid")
  if (loan.status === "COMPLETED" && !replaySettled(loan.repaymentSchedule, result)) changes.push("reopens")
  return changes
}

/** What a first go-live asks staff to accept (planChargesBackfill). */
export type AcceptanceChange = GuardedChange | "reallocates_instalments"

/**
 * The replay spreads the schedule money over the instalments differently from
 * how it is booked, beyond what a changed total explains: a receipt booked
 * instalment by instalment that s126(3) re-splits (two or more instalments
 * due, the oldest not cleared), which moves principal realised. Asked only
 * by the back-fill: once live, every sync books the s126(3) split as each
 * receipt lands, so the replay matches what is stored.
 */
export function reallocatesInstalments(
  schedule: Array<{ totalDue: number; totalPaid: number }>,
  result: DefaultChargeResult,
): boolean {
  const byInstalment = allocateReceipts(schedule, result.scheduleAllocated)
  return result.scheduleRows.some((row, i) => row.paid !== schedule[i].totalPaid && row.paid !== byInstalment[i])
}

/**
 * A sync refused because it would move money already booked to the schedule
 * onto charges, or re-open a settled loan. Only a reversal, or --apply for a
 * loan staff accepted, may do either.
 */
export class ChargesSyncRefused extends ChargesError {
  constructor(
    readonly loanId: string,
    readonly changes: GuardedChange[],
    readonly totalPaidBefore: number,
    readonly totalPaidAfter: number,
  ) {
    super(
      `Default charges would ${changes.map((change) => change === "reopens"
        ? "re-open this settled loan"
        : `move ${totalPaidBefore - totalPaidAfter} cents already booked to the instalments onto charges`).join(" and ")} `
      + `(loan ${loanId}); refused — only a payment reversal, or the back-fill --apply with the loan accepted, may do that`,
    )
    this.name = "ChargesSyncRefused"
  }
}
