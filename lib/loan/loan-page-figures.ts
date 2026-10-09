import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import type { SettlementLoanLike, SettlementScheduleRow } from "@/lib/loan/settlement"
import { MAX_WAIVABLE_BALANCE_CENTS } from "@/lib/loan/small-balance-waiver"

// The money figures on the staff loan page, in one tested place. ALL money is
// CENTS. Every "what's owed" figure includes default charges, because the
// receipt paths do; "paid" is cash received.

export async function staffLoanFigures(
  db: ChargesTx,
  loan: SettlementLoanLike & {
    id: string
    tenantId: string
    status: string
    outstandingPrincipal: number
    arrearsAmount: number
    repaymentSchedule: SettlementScheduleRow[]
  },
  asOf: Date,
) {
  const figures = await loanSettlementFigures(db, loan, asOf)
  // A notice recorded although its admin charge could not be posted
  // (finaliseSection129Issuance): staff need to see why.
  const latestNotice = await db.complianceRecord.findFirst({
    where: {
      tenantId: loan.tenantId, type: "SECTION_129_NOTICE", referenceId: loan.id, status: "COMPLETED",
      data: { path: ["lifecycle"], equals: "ISSUED" },
    },
    orderBy: { completedAt: "desc" },
    select: { data: true },
  })
  const notDerived = (latestNotice?.data as { chargesNotDerived?: unknown } | undefined)?.chargesNotDerived
  const servicing = loan.status === "ACTIVE" || loan.status === "DEFAULTED"
  const maturityBalance = loan.totalRepayable - loan.totalPaid + figures.chargesOutstanding
  return {
    charges: figures.charges,
    /** what the client must pay today to settle (s125 pricing) */
    settlementAmount: figures.totalToSettle,
    /**
     * The balance shown on the page: while charges are live, what settles the
     * loan today (the figure the portal and the NCA documents state); otherwise
     * the contractual balance at maturity, as before.
     */
    balance: figures.live ? figures.totalToSettle : maturityBalance,
    /** contractual balance at maturity, plus charges owed */
    maturityBalance,
    arrears: figures.arrearsIncludingCharges,
    cashPaid: figures.paymentsReceived,
    waivable: servicing && figures.totalToSettle >= 1 && figures.totalToSettle <= MAX_WAIVABLE_BALANCE_CENTS,
    /** why the latest Section 129 notice's admin charge was not posted, if it was not */
    chargesNotDerived: typeof notDerived === "string" ? notDerived : null,
  }
}
