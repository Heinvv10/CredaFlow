import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import { isBalanceWaiver } from "@/lib/payments/waiver"
import { hasClientBorrower } from "@/lib/borrower"
import type { SubmissionKind } from "./layout"
import type { AdverseStatus, BureauLoanInput, DataFlag } from "./map-loan"
import { dayAsOf, dayEnd, dayToDbDate, type Day } from "./period"
import type { LedgerHistory } from "./population"

// Reads one loan's as-at inputs for mapLoan. The ONLY place the feature reads
// loan, client and payment rows; every query carries the tenant id.

type Db = Pick<typeof prisma, "loan" | "bureauAdverseConfirmation"> & ChargesTx

// KNOWN: no ncaRegime or contractType here, so the balance reported for an NCA
// instalment loan is the contractual remainder, not the s125 settlement figure
// the documents and portal state (lib/loan/settlement.ts isS125InstalmentLoan).
// Which one SACRRA's current balance means is a bureau-definition question;
// switching changes every such balance on a credit profile, so it waits for it.
const LOAN_SELECT = {
  id: true,
  tenantId: true,
  reference: true,
  status: true,
  principal: true,
  initiationFee: true,
  totalInterest: true,
  totalRepayable: true,
  contractualTotalInterest: true,
  contractualTotalRepayable: true,
  totalPaid: true,
  outstandingPrincipal: true,
  arrearsAmount: true,
  interestRatePm: true,
  interestModel: true,
  startDate: true,
  maturityDate: true,
  closedAt: true,
  writeOffAt: true,
  collectionsStage: true,
  product: { select: { productType: true } },
  application: {
    select: { approvedTermDays: true, appliedTermDays: true, initiationFeePayment: true, loanPurposeCategory: true },
  },
  client: {
    select: {
      idNumber: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      addressLine1: true,
      suburb: true,
      city: true,
      postalCode: true,
      phone: true,
      employerName: true,
      monthlyIncome: true,
      deceasedAt: true,
    },
  },
  repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] },
  attorneyReferral: { select: { referralDate: true } },
  payments: {
    select: { receivedAt: true, reversed: true, reversedAt: true, allocationStatus: true, paymentMethod: true },
  },
} satisfies Prisma.LoanSelect

export async function loadBureauLoans(db: Db, tenantId: string, loanIds: string[]) {
  if (loanIds.length === 0) return []
  const loans = await db.loan.findMany({
    where: { tenantId, id: { in: loanIds } },
    select: LOAN_SELECT,
    orderBy: { reference: "asc" },
  })
  // The population (CONSUMER_BORROWER_WHERE in population.ts) never names an
  // entity borrower; this narrows `client` to non-null for mapLoan.
  return loans.filter(hasClientBorrower)
}

export type BureauLoanRow = Awaited<ReturnType<typeof loadBureauLoans>>[number]

/**
 * Whether anything happened to the loan after the period that the as-at
 * helpers cannot see past. `recomputeLoanBalances` and `loanSettlementFigures`
 * judge dates against asOf but read `totalPaid` as it is stored NOW, so a
 * later receipt, reversal, closure or write-off makes the month-end figure
 * wrong. The record is held rather than reported wrong.
 *
 * A default charge posted after the period by the nightly job, or a Section
 * 129 notice issued after it, is NOT such a thing: the charge replay stops at
 * asOf, so the month-end figure is as it was (post-period.integration.test.ts,
 * run with RUN_DB_IT=1). Three things still move a past figure and are
 * handled elsewhere: charges switched on or off for the tenant after the
 * period (prepare.ts holds the book), a status dated after the period
 * (map-loan.ts leaves it out), and an exemption granted to the loan after the
 * period, which nothing detects — the exemption date is not stored.
 */
export function hasPostPeriodActivity(loan: BureauLoanRow, periodDay: Day): boolean {
  const periodEnd = dayEnd(periodDay)
  if (loan.payments.some((p) => p.receivedAt >= periodEnd || (p.reversedAt !== null && p.reversedAt >= periodEnd))) return true
  if (loan.closedAt !== null && loan.closedAt >= periodEnd) return true
  return loan.writeOffAt !== null && loan.writeOffAt >= periodEnd
}

/**
 * Adverse statuses a staff member has confirmed, per loan. A confirmation
 * only counts for a period that ended on or after the day notice was given:
 * a listing never goes into a file for a month the consumer had no notice in.
 */
export async function loadAdverseConfirmations(db: Db, tenantId: string, loanIds: string[], periodDay: Day): Promise<Map<string, AdverseStatus[]>> {
  const rows = loanIds.length === 0 ? [] : await db.bureauAdverseConfirmation.findMany({
    where: { tenantId, loanId: { in: loanIds }, noticeDate: { lte: dayToDbDate(periodDay) } },
    select: { loanId: true, statusCode: true },
  })
  const confirmed = new Map<string, AdverseStatus[]>()
  for (const row of rows) {
    confirmed.set(row.loanId, [...(confirmed.get(row.loanId) ?? []), row.statusCode as AdverseStatus])
  }
  return confirmed
}

/** The date cash was last received on or before the period day. */
function lastPaymentOnOrBefore(loan: BureauLoanRow, day: Day): Date | null {
  const periodEnd = dayEnd(day)
  let last: Date | null = null
  for (const p of loan.payments) {
    if (p.reversed || p.allocationStatus !== "ALLOCATED" || isBalanceWaiver(p.paymentMethod)) continue
    if (p.receivedAt >= periodEnd) continue
    if (last === null || p.receivedAt > last) last = p.receivedAt
  }
  return last
}

export async function buildLoanInput(db: Db, loan: BureauLoanRow, args: {
  kind: SubmissionKind
  dataFlag: DataFlag
  day: Day
  supplierNumber: string
  confirmedAdverse: AdverseStatus[]
  history: LedgerHistory
}): Promise<BureauLoanInput> {
  const asOf = dayAsOf(args.day)
  // A settled loan reports zeros; its settlement is not worth three queries.
  const settlement = loan.status === "COMPLETED"
    ? { totalToSettle: 0, chargesOutstanding: 0 }
    : await loanSettlementFigures(db, loan, asOf)
  return {
    kind: args.kind,
    dataFlag: args.dataFlag,
    asOf,
    supplierNumber: args.supplierNumber,
    loan,
    productType: loan.product.productType,
    termDays: loan.application.approvedTermDays ?? loan.application.appliedTermDays,
    initiationFeePayment: loan.application.initiationFeePayment,
    loanPurposeCategory: loan.application.loanPurposeCategory,
    client: loan.client,
    schedule: loan.repaymentSchedule,
    settlementCents: settlement.totalToSettle,
    chargesOutstandingCents: settlement.chargesOutstanding,
    lastPaymentDate: lastPaymentOnOrBefore(loan, args.day),
    attorneyReferralDate: loan.attorneyReferral?.referralDate ?? null,
    confirmedAdverse: args.confirmedAdverse,
    alreadySent: args.history.monthlySent,
  }
}
