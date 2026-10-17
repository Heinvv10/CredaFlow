import { chargesEnabled, type ChargesTx, type LoanRef } from "@/lib/loan/charges-replay"
import { syncLoanCharges, type SyncActor, type SyncMode } from "@/lib/loan/charges-sync"
import { CASH_RECEIPTS } from "@/lib/payments/waiver"

// Small shared pieces for receipt writers once default charges exist.

/**
 * Loan.totalPaid by definition: live ALLOCATED receipts less the part of them
 * that paid default charges. Holds with charges on or off — splits are 0 on
 * every receipt booked while they were off — so a writer running with the
 * flag switched back off still keeps the ledger identity the DB guards check.
 */
export async function scheduleShareOfReceipts(tx: Pick<ChargesTx, "payment">, loanId: string): Promise<number> {
  const receipts = await tx.payment.aggregate({
    where: { loanId, reversed: false, allocationStatus: "ALLOCATED" },
    _sum: { amount: true, defaultInterestAllocated: true, chargeFeesAllocated: true },
  })
  return (receipts._sum.amount ?? 0)
    - (receipts._sum.defaultInterestAllocated ?? 0)
    - (receipts._sum.chargeFeesAllocated ?? 0)
}

/** Re-derive the loan's charges after a write, when they are live for its tenant. */
export async function resyncChargesIfLive(
  tx: ChargesTx,
  loan: Parameters<typeof chargesEnabled>[0] & { ncaRegime?: string },
  ref: LoanRef,
  asOf: Date,
  actor: SyncActor,
  mode: SyncMode = "normal",
) {
  return loan.ncaRegime === "NON_NCA" || chargesEnabled(loan) ? await syncLoanCharges(tx, ref, asOf, actor, { mode }) : null
}

/**
 * The client's most recent live payment by value date. A small-balance waiver
 * is not a payment, so it never becomes the "last payment" the Certificate of
 * Balance prints.
 */
export async function latestCashReceipt(tx: Pick<ChargesTx, "payment">, loanId: string) {
  return await tx.payment.findFirst({
    where: { loanId, reversed: false, allocationStatus: "ALLOCATED", ...CASH_RECEIPTS },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    select: { amount: true, createdAt: true, receivedAt: true },
  })
}

/**
 * The closing date of a loan a receipt settles: the value date of its last
 * live receipt — a back-dated receipt that settles the loan does not close it
 * before a later receipt already on it.
 */
export async function closingValueDate(tx: Pick<ChargesTx, "payment">, loanId: string, receivedAt: Date): Promise<Date> {
  const latest = await tx.payment.findFirst({
    where: { loanId, reversed: false, allocationStatus: "ALLOCATED" },
    orderBy: [{ receivedAt: "desc" }],
    select: { receivedAt: true },
  })
  return latest && latest.receivedAt > receivedAt ? latest.receivedAt : receivedAt
}
