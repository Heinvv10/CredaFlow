import { commonLawReplayRows } from "@/lib/asset-finance/common-law-interest"
import type { LoanStatus } from "@prisma/client"
import { AuditAction } from "@/lib/audit"
import { nextPaymentDueDate, recomputeLoanBalances } from "@/lib/loan/balances"
import {
  chargesOutstandingTotal,
  loadChargesReplay,
  type ChargesTx,
  type LoanRef,
} from "@/lib/loan/charges-replay"
import { ChargesError } from "@/lib/loan/charges-error"
import { ChargesSyncRefused, guardedChanges, replaySettled, syncRefusal } from "@/lib/loan/charges-verdict"

export type SyncMode = "normal" | "reversal" | "backfill"

// Persists the default-charges replay (lib/loan/default-charges.ts) for one
// loan. ALL money is CENTS. Every value written here is DERIVED from the booked
// schedule, the live receipts and the issued Section 129 notices, so a receipt,
// a reversal, a back-dated receipt or a new notice is absorbed by re-running
// this, never by patching a running total.
//
// Callers hold the loan lock (lockLoanForUpdate) and run inside the same
// transaction that wrote the Payment row.

export interface ChargesSyncResult {
  totalPaid: number
  status: LoanStatus
  closedAt: Date | null
  chargesAccrued: number
  chargesOutstanding: number
  /** false when the replay matched what was already stored: nothing written */
  changed: boolean
}

const chargeKeys = (charges: Array<{ type: string; day: Date; amount: number; sourceId: string | null }>) =>
  JSON.stringify(charges.map((c) => [c.type, c.day.toISOString().slice(0, 10), c.amount, c.sourceId]))

/**
 * Re-derive and persist a loan's charges, the charge split of every live
 * receipt, and everything that follows from the schedule share: Loan.totalPaid,
 * the schedule rows, balances and status. Returns null (and writes nothing)
 * for NCA loans while the tenant's flag is off. NON_NCA contractual interest
 * is always replayed to enforce the common-law ceiling.
 */
export interface SyncActor {
  /** the writer or job, e.g. "manual_capture", "stitch_webhook", "cron:default-charges" */
  source: string
  userId?: string | null
  userEmail?: string | null
}

export async function syncLoanCharges(
  tx: ChargesTx,
  ref: LoanRef,
  asOf: Date,
  /** who or what ran the sync, recorded on its audit row — required, so no writer can omit it */
  actor: SyncActor,
  /**
   * `normal` (every writer, the cron, exemptions, notices, waivers) refuses to
   * lower Loan.totalPaid or re-open a settled loan (ChargesSyncRefused). Only a
   * `reversal`, or the back-fill for a loan staff `accepted`, may.
   */
  { mode = "normal", accepted }: { mode?: SyncMode; accepted?: ReadonlySet<string> } = {},
): Promise<ChargesSyncResult | null> {
  // The sync decides COMPLETED itself, so a writer's closing date must not
  // bound the replay it decides from.
  const replay = await loadChargesReplay(tx, ref, asOf, { decidingStatus: true })
  if (!replay) return null
  const { loan, receipts, result } = replay
  const refusal = syncRefusal(ref.loanId, loan, result)
  if (refusal) throw new ChargesError(refusal)
  const guarded = guardedChanges(loan, result)
  if (guarded.length > 0 && !(mode === "reversal" || (mode === "backfill" && accepted?.has(ref.loanId)))) {
    throw new ChargesSyncRefused(ref.loanId, guarded, loan.totalPaid, result.scheduleAllocated)
  }
  if (replay.unbookedServiceFee !== null) {
    // Booked by an image that predates the column: record the fee it replays
    // at now, so a later product edit can never move it.
    await tx.loan.update({
      where: { id: ref.loanId, tenantId: ref.tenantId },
      data: { monthlyServiceFee: replay.unbookedServiceFee },
    })
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId, userId: actor.userId ?? null, userEmail: actor.userEmail ?? null,
        action: AuditAction.LOAN_SERVICE_FEE_RECORDED, entity: "Loan", entityId: ref.loanId,
        oldValue: { monthlyServiceFee: null },
        newValue: { monthlyServiceFee: replay.unbookedServiceFee, source: actor.source },
      },
    })
  }

  const chargesAccrued = result.interestAccrued + result.feesAccrued
  const chargesOutstanding = chargesOutstandingTotal(result)
  const postings = result.postings.map((posting) => ({
    tenantId: ref.tenantId,
    loanId: ref.loanId,
    type: posting.type,
    day: new Date(`${posting.day}T00:00:00.000Z`),
    amount: posting.amount,
    sourceId: posting.sourceId ?? null,
  }))
  const existing = await tx.loanCharge.findMany({
    where: { tenantId: ref.tenantId, loanId: ref.loanId },
    orderBy: [{ day: "asc" }, { createdAt: "asc" }],
    select: { type: true, day: true, amount: true, sourceId: true },
  })
  const chargesChanged = chargeKeys(existing) !== chargeKeys(postings)
  if (chargesChanged) {
    await tx.loanCharge.deleteMany({ where: { tenantId: ref.tenantId, loanId: ref.loanId } })
    if (postings.length > 0) await tx.loanCharge.createMany({ data: postings })
  }

  const receiptDate = new Map(receipts.map((receipt) => [receipt.id, receipt.receivedAt]))
  const changedSplits = result.receiptSplits.filter((split) => {
    const receipt = receipts.find((r) => r.id === split.receiptId)!
    return receipt.defaultInterestAllocated !== split.toDefaultInterest
      || receipt.chargeFeesAllocated !== split.toFees
  })
  for (const split of changedSplits) {
    await tx.payment.update({
      where: { id: split.receiptId, tenantId: ref.tenantId },
      data: { defaultInterestAllocated: split.toDefaultInterest, chargeFeesAllocated: split.toFees },
    })
  }

  // The replay's per-instalment shares. A paid row is dated by the live
  // receipt whose schedule share completed it, re-dated when that changes
  // (the receipt that completed it was reversed) though its totalPaid did not.
  const rows = commonLawReplayRows(loan.repaymentSchedule, result)
  const postRows = rows.map((row, i) => ({ ...row, totalPaid: result.scheduleRows[i].paid }))
  let rowsChanged = false
  for (const [i, row] of postRows.entries()) {
    const isPaid = row.totalPaid >= row.totalDue
    const completing = result.scheduleRows[i].completedBy
    const paidAt = !isPaid ? null : completing ? receiptDate.get(completing)! : rows[i].paidAt ?? asOf
    const original = loan.repaymentSchedule[i]
    if (row.totalPaid === original.totalPaid && row.interestDue === original.interestDue && row.commonLawContractualInterestDue === original.commonLawContractualInterestDue && paidAt?.valueOf() === original.paidAt?.valueOf()) continue
    rowsChanged = true
    await tx.repaymentSchedule.update({
      where: { id: row.id, tenantId: ref.tenantId },
      data: {
        totalPaid: row.totalPaid,
        ...(result.lawfulSchedule ? { interestDue: row.interestDue, totalDue: row.totalDue, commonLawContractualInterestDue: row.commonLawContractualInterestDue } : {}),
        status: isPaid ? "PAID" : row.totalPaid > 0 ? "PARTIAL" : "PENDING",
        paidAt,
      },
    })
  }

  // Closed only when the schedule AND every charge are paid. A COMPLETED loan
  // that no longer is (a reversal, a notice issued after settlement) re-opens;
  // no other status is touched here.
  const settled = replaySettled(rows, result)
  let status: LoanStatus = loan.status
  let closedAt = loan.closedAt
  if (settled && (status === "ACTIVE" || status === "DEFAULTED" || status === "COMPLETED")) {
    // Closed on the value date of the last live receipt, whichever writer
    // marked it — never an earlier, back-dated receipt's date.
    status = "COMPLETED"
    closedAt = receipts.at(-1)?.receivedAt ?? loan.closedAt ?? asOf
  } else if (!settled && status === "COMPLETED") {
    status = "ACTIVE"
    closedAt = null
  }

  const balances = recomputeLoanBalances(loan.principal, postRows, asOf)
  const capped = loan.ncaRegime === "NON_NCA" && rows.some((r, i) => r.interestDue !== loan.repaymentSchedule[i].interestDue)
  const next = {
    ...(capped ? { totalInterest: rows.reduce((sum, r) => sum + r.interestDue, 0), totalRepayable: rows.reduce((sum, r) => sum + r.totalDue, 0),
      contractualTotalInterest: loan.contractualTotalInterest ?? loan.totalInterest,
      contractualTotalRepayable: loan.contractualTotalRepayable ?? loan.totalRepayable } : {}),
    totalPaid: result.scheduleAllocated,
    outstandingPrincipal: balances.outstandingPrincipal,
    arrearsAmount: balances.arrearsAmount,
    daysInArrears: balances.daysInArrears,
    nextPaymentDate: nextPaymentDueDate(postRows),
    chargesAccrued,
    chargesOutstanding,
    status,
    closedAt,
  }
  const loanChanged = (Object.keys(next) as Array<keyof typeof next>).some((key) => {
    const before = loan[key]
    const after = next[key]
    return before instanceof Date || after instanceof Date
      ? before?.valueOf() !== after?.valueOf()
      : before !== after
  })
  if (loanChanged) {
    await tx.loan.update({ where: { id: ref.loanId, tenantId: ref.tenantId }, data: next })
  }

  // Also when only totalPaid moved (a writer booked charge money as schedule
  // money), or only the instalments, principal or status did: s126(3) can
  // re-split the instalments, moving principal with totalPaid unchanged. Not
  // for DPD, arrears or next payment date alone, which the DPD cron rewrites
  // unaudited.
  if (
    chargesChanged || changedSplits.length > 0 || rowsChanged || loan.totalPaid !== next.totalPaid
    || loan.outstandingPrincipal !== next.outstandingPrincipal || loan.status !== next.status
    || loan.closedAt?.valueOf() !== next.closedAt?.valueOf()
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId,
        userId: actor.userId ?? null,
        userEmail: actor.userEmail ?? null,
        action: AuditAction.LOAN_CHARGES_SYNCED,
        entity: "Loan",
        entityId: ref.loanId,
        oldValue: {
          chargesAccrued: loan.chargesAccrued,
          chargesOutstanding: loan.chargesOutstanding,
          totalPaid: loan.totalPaid,
          outstandingPrincipal: loan.outstandingPrincipal,
          daysInArrears: loan.daysInArrears,
        },
        newValue: {
          asOf: asOf.toISOString(),
          source: actor.source,
          chargesAccrued,
          chargesOutstanding,
          defaultInterestAccrued: result.interestAccrued,
          ...(result.lawfulSchedule ? { commonLawRows: result.lawfulSchedule } : {}),
          feesAccrued: result.feesAccrued,
          monthlyServiceFee: replay.monthlyServiceFee,
          totalPaid: result.scheduleAllocated,
          outstandingPrincipal: next.outstandingPrincipal,
          daysInArrears: next.daysInArrears,
          postings: result.postings.map((p) => ({ ...p })),
          receiptSplits: changedSplits.map((s) => ({ ...s })),
          inDuplum: result.inDuplum ? { ...result.inDuplum } : null,
        },
      },
    })
  }
  if (status !== loan.status || closedAt?.valueOf() !== loan.closedAt?.valueOf()) {
    await tx.auditLog.create({
      data: {
        tenantId: ref.tenantId,
        action: AuditAction.LOAN_STATUS_CHANGED,
        entity: "Loan",
        entityId: ref.loanId,
        oldValue: { status: loan.status, closedAt: loan.closedAt?.toISOString() ?? null },
        newValue: {
          status,
          closedAt: closedAt?.toISOString() ?? null,
          reason: status !== "COMPLETED" ? "charges_outstanding"
            : status === loan.status ? "closing_date_is_last_receipt" : "settled_including_charges",
        },
      },
    })
  }

  return {
    totalPaid: result.scheduleAllocated,
    status,
    closedAt,
    chargesAccrued,
    chargesOutstanding,
    changed: chargesChanged || changedSplits.length > 0 || rowsChanged || loanChanged,
  }
}
