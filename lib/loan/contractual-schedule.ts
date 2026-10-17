import type { prisma } from "@/lib/prisma"
import {
  isS125InstalmentLoan,
  restoreContractualBulletSchedule,
  type ContractualRow,
  type SettlementLoanLike,
  type SettlementScheduleRow,
} from "@/lib/loan/settlement"

// The schedule as contracted, before an early settlement re-priced it. A
// payment reversal re-opens a loan on it, and the book as at an earlier date
// is rebuilt on it. A DAILY_ACCRUAL bullet is restored from the loan's
// contractual totals; an instalment loan from the rows the settling receipt's
// audit row recorded (lib/loan/settlement.ts settlementAuditEvidence), which
// the database binds to the PASQ for a PASQ v3 loan (migration
// 20261016200000_s125_instalment_settlement) — so this works for loans booked
// before PASQ v3 too.

/** A reason a re-priced schedule cannot be put back; `userMessage` is safe to show staff. */
export class ContractualScheduleError extends Error {
  constructor(message: string, readonly userMessage: string) {
    super(message)
    this.name = "ContractualScheduleError"
  }
}

export class ContractualScheduleMissingError extends ContractualScheduleError {
  constructor(readonly loanId: string) {
    super(
      `Loan ${loanId} was settled early but its contractual schedule evidence is missing`,
      "This loan was settled early and its contractual schedule cannot be restored; refer it to an administrator",
    )
    this.name = "ContractualScheduleMissingError"
  }
}

/**
 * Reversing a receipt other than the one that settled the loan early would
 * re-open it on the contract while the settlement receipt still stands, priced
 * on money that is no longer there. The settlement receipt is reversed first.
 */
export class SettlementReceiptFirstError extends ContractualScheduleError {
  constructor(readonly loanId: string, readonly settlementPaymentId: string) {
    super(
      `Loan ${loanId} was settled early by payment ${settlementPaymentId}; reverse that receipt first`,
      "This loan was settled early by a later receipt. Reverse the settlement receipt first, then this one, and re-capture the settlement if it still stands.",
    )
    this.name = "SettlementReceiptFirstError"
  }
}

const isInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** The recorded contractual rows, or null if the value is not a well-formed list of them. */
export function readContractualRows(value: unknown): ContractualRow[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const rows: ContractualRow[] = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    if (typeof r.id !== "string" || !isInt(r.principalDue) || !isInt(r.interestDue) || !isInt(r.feesDue)
      || !isInt(r.creditLifePremiumDue) || !isInt(r.totalDue)) return null
    if (r.totalDue !== r.principalDue + r.interestDue + r.feesDue) return null
    rows.push({
      id: r.id, installmentNo: isInt(r.installmentNo) ? r.installmentNo : null,
      principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue,
      creditLifePremiumDue: r.creditLifePremiumDue, totalDue: r.totalDue,
    })
  }
  return rows
}

/** An instalment loan whose rows an early settlement re-priced. */
export function isRepricedInstalmentLoan(loan: SettlementLoanLike, schedule: SettlementScheduleRow[]): boolean {
  return isS125InstalmentLoan(loan, schedule)
    && loan.contractualTotalRepayable != null
    && loan.totalRepayable < loan.contractualTotalRepayable
}

/**
 * Pure: the schedule with each recorded row's contractual money put back,
 * matched by instalment number as the database matches them; a recorded row
 * that does not fit the schedule refuses the restore.
 */
export function restoreContractualSchedule<T extends SettlementScheduleRow>(args: {
  loan: SettlementLoanLike
  schedule: T[]
  contractualRows: ContractualRow[] | null
}): T[] {
  if (!args.contractualRows) return restoreContractualBulletSchedule(args) as T[]
  const byNo = new Map(args.contractualRows.map((row) => [row.installmentNo, row]))
  const fits = byNo.size === args.schedule.length && args.contractualRows.length === args.schedule.length
    && args.schedule.every((row) => byNo.get(row.installmentNo ?? null)?.id === row.id)
  if (!fits) throw new ContractualScheduleMissingError(args.loan.id ?? "unknown")
  return args.schedule.map((row) => {
    const recorded = byNo.get(row.installmentNo ?? null)!
    return {
      ...row,
      interestDue: recorded.interestDue,
      feesDue: recorded.feesDue,
      creditLifePremiumDue: recorded.creditLifePremiumDue,
      totalDue: recorded.totalDue,
    }
  })
}

// The audit rows a receipt writer records an early settlement on, and the
// entity each names. The database binds the evidence the same way (migration
// 20261016200000_s125_instalment_settlement), and refuses the evidence keys on
// any other audit row.
const RECEIPT_ENTITY: Record<string, "Loan" | "Payment" | "BankTransaction"> = {
  PAYMENT_RECORDED: "Loan",
  SMALL_BALANCE_WAIVED: "Loan",
  PAYMENT_ALLOCATED: "Payment",
  BANK_TXN_RECONCILED: "BankTransaction",
}

export interface SettlementEvidence {
  /** the receipt that settled the loan */
  paymentId: string
  rows: ContractualRow[]
}

type EvidenceDb = Pick<typeof prisma, "auditLog" | "payment" | "repaymentSchedule" | "bankTransaction">

/**
 * The latest early instalment settlement of each loan: the audit row a receipt
 * writer recorded it on, for a live allocated receipt on that loan whose
 * amount is the settlement figure, with a contractual row for each row of the
 * loan's own schedule. `reversingPaymentId` is a receipt being reversed in
 * this transaction, still accepted as the settlement.
 */
export async function loadSettlementEvidence(
  db: EvidenceDb, tenantId: string, loanIds: string[], reversingPaymentId?: string,
): Promise<Map<string, SettlementEvidence>> {
  const found = new Map<string, SettlementEvidence>()
  if (loanIds.length === 0) return found
  const audits = await db.auditLog.findMany({
    where: {
      tenantId,
      action: { in: Object.keys(RECEIPT_ENTITY) },
      AND: [
        { newValue: { path: ["earlyInstalmentSettlement"], equals: true } },
        ...(loanIds.length === 1 ? [{ newValue: { path: ["loanId"], equals: loanIds[0] } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, entity: true, entityId: true, newValue: true },
  })
  const wanted = new Set(loanIds)
  const candidates = audits.flatMap((audit) => {
    const value = audit.newValue as Record<string, unknown> | null
    const loanId = typeof value?.loanId === "string" ? value.loanId : null
    const paymentId = typeof value?.paymentId === "string" ? value.paymentId : null
    const rows = readContractualRows(value?.contractualRows)
    if (!loanId || !wanted.has(loanId) || !paymentId || !rows || audit.entity !== RECEIPT_ENTITY[audit.action]) return []
    return [{ ...audit, loanId, paymentId, rows, settlementDue: value?.settlementDue }]
  })
  if (candidates.length === 0) return found
  const [payments, deposits, schedule] = await Promise.all([
    db.payment.findMany({
      where: { tenantId, id: { in: candidates.map((c) => c.paymentId) } },
      select: { id: true, loanId: true, amount: true, reversed: true, allocationStatus: true },
    }),
    db.bankTransaction.findMany({
      where: { tenantId, id: { in: candidates.flatMap((c) => (c.entity === "BankTransaction" && c.entityId ? [c.entityId] : [])) } },
      select: { id: true, paymentId: true },
    }),
    db.repaymentSchedule.findMany({ where: { tenantId, loanId: { in: loanIds } }, select: { id: true, loanId: true, installmentNo: true } }),
  ])
  const paymentById = new Map(payments.map((p) => [p.id, p]))
  const depositPayment = new Map(deposits.map((d) => [d.id, d.paymentId]))
  for (const c of candidates) {
    if (found.has(c.loanId)) continue
    const payment = paymentById.get(c.paymentId)
    const live = payment && payment.loanId === c.loanId && payment.allocationStatus === "ALLOCATED"
      && (!payment.reversed || payment.id === reversingPaymentId) && payment.amount === c.settlementDue
    const named = c.entity === "Loan" ? c.entityId === c.loanId
      : c.entity === "Payment" ? c.entityId === c.paymentId
        : c.entityId !== null && depositPayment.get(c.entityId) === c.paymentId
    const own = schedule.filter((row) => row.loanId === c.loanId)
    const fits = own.length === c.rows.length
      && c.rows.every((row) => own.some((o) => o.id === row.id && o.installmentNo === row.installmentNo))
    if (live && named && fits) found.set(c.loanId, { paymentId: c.paymentId, rows: c.rows })
  }
  return found
}

/**
 * One loan's contractual schedule for a reversal of `reversingPaymentId`:
 * refuses a re-priced loan whose evidence is missing, and the reversal of any
 * receipt but the one that settled it.
 */
export async function contractualScheduleOf<T extends SettlementScheduleRow>(
  db: EvidenceDb,
  loan: SettlementLoanLike & { id: string; tenantId: string },
  schedule: T[],
  reversingPaymentId: string,
): Promise<T[]> {
  if (!isRepricedInstalmentLoan(loan, schedule)) {
    return restoreContractualSchedule({ loan, schedule, contractualRows: null })
  }
  const evidence = (await loadSettlementEvidence(db, loan.tenantId, [loan.id], reversingPaymentId)).get(loan.id)
  if (!evidence) throw new ContractualScheduleMissingError(loan.id)
  if (evidence.paymentId !== reversingPaymentId) throw new SettlementReceiptFirstError(loan.id, evidence.paymentId)
  return restoreContractualSchedule({ loan, schedule, contractualRows: evidence.rows })
}
