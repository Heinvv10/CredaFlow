import { calculateLoanFromDecisionInputs, frozenApprovedTerms, readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"

/** The approved terms as printed on the key facts statement and the agreement (all money in cents). */
export interface QuoteFigures {
  principalCents: number
  termDays: number
  interestRatePm: number
  initiationFeeCents: number
  serviceFeesCents: number
  monthlyInstalmentCents: number
  totalInterestCents: number
  totalRepayableCents: number
  instalments: number
  firstDueDate: Date
  lastDueDate: Date
  repaymentMethod: string
}

export class QuoteUnavailableError extends Error {
  constructor(readonly reason: "missing" | "changed" | "no_schedule") {
    super(
      reason === "no_schedule"
        ? "The approved terms produce no repayment schedule"
        : "The application has no intact approval to quote: approve it (or return it to review and approve it again)",
    )
    this.name = "QuoteUnavailableError"
  }
}

/**
 * The approved terms of an application, from the approval it was decided on (the
 * frozen pricing, lib/affordability/snapshot.ts), not from the product row as it
 * stands now. The same calculator the PASQ uses, so a figure printed here is a
 * figure the loan is booked on.
 */
export function quoteFor(application: { affordabilityResult: unknown; repaymentMethod: string | null }): QuoteFigures {
  const frozen = frozenApprovedTerms(application.affordabilityResult)
  if (!frozen.ok) throw new QuoteUnavailableError(frozen.reason)
  const approval = readAffordabilitySnapshotStore(application.affordabilityResult).approval
  if (!approval) throw new QuoteUnavailableError("missing")
  const calculation = calculateLoanFromDecisionInputs(frozen.terms, new Date(approval.calculator.startDate))
  const first = calculation.schedule[0]
  const last = calculation.schedule.at(-1)
  if (!first || !last) throw new QuoteUnavailableError("no_schedule")
  return {
    principalCents: calculation.principal,
    termDays: frozen.terms.termDays,
    interestRatePm: frozen.terms.interestRatePm,
    initiationFeeCents: calculation.initiationFee,
    serviceFeesCents: calculation.serviceFees,
    monthlyInstalmentCents: calculation.monthlyInstalment || first.totalDue,
    totalInterestCents: calculation.totalInterest,
    totalRepayableCents: calculation.totalRepayable,
    instalments: calculation.schedule.length,
    firstDueDate: first.dueDate,
    lastDueDate: last.dueDate,
    repaymentMethod: application.repaymentMethod ?? "",
  }
}

/** Figures for the template editor's preview (app/api/documents/templates/[id]/preview): synthetic, so the quote.* tokens render before any application exists. */
export const SAMPLE_QUOTE: QuoteFigures = {
  principalCents: 1_000_000,
  termDays: 180,
  interestRatePm: 0.025,
  initiationFeeCents: 105_000,
  serviceFeesCents: 41_400,
  monthlyInstalmentCents: 195_000,
  totalInterestCents: 90_000,
  totalRepayableCents: 1_236_400,
  instalments: 6,
  firstDueDate: new Date("2027-01-31T00:00:00Z"),
  lastDueDate: new Date("2027-06-30T00:00:00Z"),
  repaymentMethod: "EFT",
}
