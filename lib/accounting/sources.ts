/**
 * What each money source SHOULD have posted to the ledger as at an instant.
 *
 * Every source (a loan's disbursement, each instalment, each default charge,
 * each receipt, the write-off) yields a desired cumulative vector of signed
 * cents per account role (+ debit, - credit) that always sums to zero. The
 * export posts the difference between that and what earlier batches posted
 * (lib/accounting/derive.ts), so a source that changes after its month closed
 * (a reversal, a refund, a re-derived default charge, an early settlement's
 * reduced interest) is corrected in the next open month, never by editing a
 * closed one.
 *
 * The loan book is one receivable for everything a borrower owes. Income is
 * recognised when it falls due: interest, fees and premiums when their
 * instalment is due, default charges on their day. A receipt credits the loan
 * book as a whole: the system does not store a receipt's principal/interest
 * split (it is re-derived by replay and moves with backdating), so splitting
 * receipts by component here would invent figures.
 */
import type { AccountRole } from "./accounts"

export type Vector = Partial<Record<AccountRole, number>>

export type EventType =
  | "DISBURSEMENT"
  | "INSTALMENT_DUE"
  | "DEFAULT_CHARGE"
  | "RECEIPT"
  | "WAIVER"
  | "REVERSAL"
  | "REFUND"
  | "ALLOCATION"
  | "WRITE_OFF"
  | "ADJUSTMENT"

export interface SourceLoan {
  id: string
  reference: string
  principal: number
  initiationFee: number
  /** The initiation fee was deducted from the cash advanced (InitiationFeePayment.UPFRONT). */
  upfrontFee: boolean
  startDate: Date
  status: string
  writeOffAt: Date | null
  closedAt: Date | null
  schedule: Array<{ id: string; installmentNo: number; dueDate: Date; interestDue: number; feesDue: number; creditLifePremiumDue: number }>
  /** `day` is the SAST calendar day as SAST midnight. */
  charges: Array<{ type: string; day: Date; amount: number; sourceId: string | null }>
  payments: Array<{
    id: string
    amount: number
    paymentMethod: string
    receivedAt: Date
    allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
    reconciledAt: Date | null
    reversed: boolean
    reversedAt: Date | null
  }>
}

export interface DesiredSource {
  baseKey: string
  loanId: string
  reference: string
  vector: Vector
  /** Label and date of the source's first posting. */
  origin: { type: EventType; date: Date; description: string }
  /** Label and date of a later correction (a delta after the first posting). */
  change: { type: EventType; date: Date | null; description: string }
}

export function addTo(vector: Vector, role: AccountRole, cents: number): Vector {
  if (cents !== 0) vector[role] = (vector[role] ?? 0) + cents
  return vector
}

const before = (date: Date | null, asOf: Date) => date !== null && date.getTime() < asOf.getTime()

function writtenOffAt(loan: SourceLoan, asOf: Date): Date | null {
  return loan.status === "WRITTEN_OFF" && before(loan.writeOffAt, asOf) ? loan.writeOffAt : null
}

/** The day a schedule item or charge is raised, or null when it never is (after a write-off or cancellation). */
function raisedOn(loan: SourceLoan, due: Date, asOf: Date): Date | null {
  const writeOff = writtenOffAt(loan, asOf)
  if (writeOff && writeOff.getTime() <= due.getTime()) return null
  if (loan.status === "CANCELLED" && loan.closedAt && loan.closedAt.getTime() <= due.getTime()) return null
  // An early settlement re-states the remaining instalments' interest to what
  // accrued; that income is earned on the day the loan closed, not later.
  const on = loan.status === "COMPLETED" && loan.closedAt && loan.closedAt.getTime() < due.getTime() ? loan.closedAt : due
  return before(on, asOf) ? on : null
}

const CHARGE_INCOME: Record<string, AccountRole> = {
  DEFAULT_INTEREST: "DEFAULT_INTEREST_INCOME",
  SERVICE_FEE: "DEFAULT_FEE_INCOME",
  DEFAULT_ADMIN: "DEFAULT_FEE_INCOME",
  COLLECTION_FEE: "DEFAULT_FEE_INCOME",
}

function paymentSource(loan: SourceLoan, p: SourceLoan["payments"][number], asOf: Date): DesiredSource {
  const waiver = p.paymentMethod === "WAIVER"
  const vector: Vector = {}
  const received = before(p.receivedAt, asOf)
  const reversed = p.reversed && before(p.reversedAt, asOf)
  // A status set by reconciliation after `asOf` was still UNAPPLIED at `asOf`.
  const status = p.allocationStatus !== "UNAPPLIED" && p.reconciledAt && !before(p.reconciledAt, asOf)
    ? "UNAPPLIED"
    : p.allocationStatus
  if (received && !reversed && status !== "REFUNDED") {
    const writeOff = writtenOffAt(loan, asOf)
    const credit: AccountRole = status === "UNAPPLIED"
      ? "UNALLOCATED_RECEIPTS"
      : writeOff && writeOff.getTime() <= p.receivedAt.getTime() ? "BAD_DEBT_RECOVERY" : "LOAN_BOOK"
    addTo(vector, waiver ? "WAIVER_EXPENSE" : "BANK", p.amount)
    addTo(vector, credit, -p.amount)
  }
  const change: DesiredSource["change"] = reversed
    ? { type: "REVERSAL", date: p.reversedAt, description: `Receipt reversed on ${loan.reference}` }
    : status === "REFUNDED"
      ? { type: "REFUND", date: p.reconciledAt, description: `Unallocated receipt refunded on ${loan.reference}` }
      : status === "ALLOCATED" && p.reconciledAt
        ? { type: "ALLOCATION", date: p.reconciledAt, description: `Unallocated receipt applied to ${loan.reference}` }
        : { type: "ADJUSTMENT", date: null, description: `Receipt re-stated on ${loan.reference}` }
  return {
    baseKey: `payment:${p.id}`,
    loanId: loan.id,
    reference: loan.reference,
    vector,
    origin: waiver
      ? { type: "WAIVER", date: p.receivedAt, description: `Balance waived on ${loan.reference}` }
      : { type: "RECEIPT", date: p.receivedAt, description: `Receipt on ${loan.reference}` },
    change,
  }
}

function adjustment(loan: SourceLoan, what: string): DesiredSource["change"] {
  return { type: "ADJUSTMENT", date: null, description: `${what} re-stated on ${loan.reference}` }
}

/** Every source of one loan, desired as at `asOf` (exclusive), write-off excluded. */
function ordinarySources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const out: DesiredSource[] = []
  const disbursement: Vector = {}
  if (before(loan.startDate, asOf)) {
    const fee = loan.upfrontFee ? loan.initiationFee : 0
    addTo(disbursement, "LOAN_BOOK", loan.principal)
    addTo(disbursement, "BANK", -(loan.principal - fee))
    addTo(disbursement, "FEE_INCOME", -fee)
  }
  out.push({
    baseKey: `loan:${loan.id}:disbursement`, loanId: loan.id, reference: loan.reference, vector: disbursement,
    origin: { type: "DISBURSEMENT", date: loan.startDate, description: `Loan ${loan.reference} paid out` },
    change: adjustment(loan, "Disbursement"),
  })
  for (const row of loan.schedule) {
    const on = raisedOn(loan, row.dueDate, asOf)
    const vector: Vector = {}
    if (on) {
      const fees = row.feesDue - row.creditLifePremiumDue
      addTo(vector, "LOAN_BOOK", row.interestDue + row.feesDue)
      addTo(vector, "INTEREST_INCOME", -row.interestDue)
      addTo(vector, "FEE_INCOME", -fees)
      addTo(vector, "CREDIT_LIFE_PAYABLE", -row.creditLifePremiumDue)
    }
    out.push({
      baseKey: `loan:${loan.id}:instalment:${row.id}`, loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "INSTALMENT_DUE", date: on ?? row.dueDate, description: `Instalment ${row.installmentNo} interest, fees and premium due on ${loan.reference}` },
      change: adjustment(loan, `Instalment ${row.installmentNo}`),
    })
  }
  for (const charge of loan.charges) {
    const on = raisedOn(loan, charge.day, asOf)
    const vector: Vector = {}
    if (on) {
      addTo(vector, "LOAN_BOOK", charge.amount)
      addTo(vector, CHARGE_INCOME[charge.type] ?? "DEFAULT_FEE_INCOME", -charge.amount)
    }
    out.push({
      baseKey: `loan:${loan.id}:charge:${charge.type}:${charge.day.toISOString()}:${charge.sourceId ?? ""}`,
      loanId: loan.id, reference: loan.reference, vector,
      origin: { type: "DEFAULT_CHARGE", date: charge.day, description: `${charge.type.replaceAll("_", " ").toLowerCase()} charged on ${loan.reference}` },
      change: adjustment(loan, "Default charge"),
    })
  }
  for (const payment of loan.payments) out.push(paymentSource(loan, payment, asOf))
  return out
}

/**
 * All of a loan's sources as at `asOf`. A written-off loan's write-off takes
 * whatever its other sources leave on the loan book, so the book holds nothing
 * for it once written off, and a later change (a reversed receipt) moves the
 * write-off with it.
 */
export function loanSources(loan: SourceLoan, asOf: Date): DesiredSource[] {
  const sources = ordinarySources(loan, asOf)
  const writeOff = writtenOffAt(loan, asOf)
  const vector: Vector = {}
  if (writeOff) {
    const book = sources.reduce((sum, s) => sum + (s.vector.LOAN_BOOK ?? 0), 0)
    if (book > 0) {
      addTo(vector, "BAD_DEBT_EXPENSE", book)
      addTo(vector, "LOAN_BOOK", -book)
    }
  }
  sources.push({
    baseKey: `loan:${loan.id}:write-off`, loanId: loan.id, reference: loan.reference, vector,
    origin: { type: "WRITE_OFF", date: loan.writeOffAt ?? loan.startDate, description: `Loan ${loan.reference} written off` },
    change: adjustment(loan, "Write-off"),
  })
  return sources
}
