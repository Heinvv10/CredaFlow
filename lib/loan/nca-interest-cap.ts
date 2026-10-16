// NCA statutory ceiling on the contractual interest rate.
//
// ⚠️ GAZETTED FIGURES. National Credit Regulations, Regulation 42(1) Table A,
// as substituted by GN R1080 in Government Gazette 39379 (6 November 2015,
// in force 6 May 2016). Legal must confirm against the current Gazette before
// relying on them. The table, per credit type:
//
//   Mortgage agreements                RR + 12% per year
//   Credit facilities                  RR + 14% per year
//   Unsecured credit transactions      RR + 21% per year
//   Developmental credit agreements    RR + 20% per year
//   Short-term credit transactions     5% per month on the first loan,
//                                      3% per month on subsequent loans
//                                      within a calendar year
//   Other credit agreements            RR + 17% per year (lib/asset-finance/nca-caps.ts)
//   Incidental credit agreements       2% per month
//
// RR is the South African Reserve Bank repurchase (repo) rate, read from the
// tenant's APPROVED reference rates (basis REPO, lib/asset-finance/rates-store.ts).
//
// Consumer credit in this system is unsecured and is never a mortgage, a
// credit facility or incidental credit, so it is one of two types, decided by
// the transaction's facts and not by the product's label (NCA s1):
//   SHORT_TERM — principal debt at most R8,000, repaid in full within 6 months;
//   UNSECURED  — everything else.
// The older "(RR x 2.2) + 20%" unsecured formula predates GN R1080 and is not
// used.
//
// NOT IMPLEMENTED: the 3%-per-month ceiling on a consumer's subsequent
// short-term loans within a calendar year. A product carries one rate, so it
// needs a per-application rate or a separate repeat product: a product
// decision, reported rather than guessed.

import { annualisedInterestRate } from "@/lib/loan/annualised-rate"

export const NCA_INTEREST_CAP = {
  /** s1 short-term credit transaction: principal debt at most R8,000 (cents). */
  shortTermMaxPrincipalCents: 800_000,
  /** ...repaid within 6 months: 6 x 30 days, the month this system bills in (lib/loan-calculator.ts). */
  shortTermMaxTermDays: 180,
  /** Short-term: 5% per month (first loan in the calendar year). */
  shortTermMonthlyRate: 0.05,
  /** Unsecured: repo + 21% per year. */
  unsecuredRepoMargin: 0.21,
} as const

export type NcaCreditType = "SHORT_TERM" | "UNSECURED"

export const NCA_CREDIT_TYPE_LABELS: Record<NcaCreditType, string> = {
  SHORT_TERM: "short-term credit transaction",
  UNSECURED: "unsecured credit transaction",
}

/** The credit type of one transaction. */
export function ncaCreditType(principalCents: number, termDays: number): NcaCreditType {
  return principalCents <= NCA_INTEREST_CAP.shortTermMaxPrincipalCents
    && termDays <= NCA_INTEREST_CAP.shortTermMaxTermDays
    ? "SHORT_TERM"
    : "UNSECURED"
}

/**
 * A product's rate applies to every loan it can write, so it must sit under the
 * cap of the strictest type it can produce: short-term only if its largest
 * amount AND its longest term are both short-term.
 */
export function productCreditType(product: { maxAmount: number; maxTermDays: number }): NcaCreditType {
  return ncaCreditType(product.maxAmount, product.maxTermDays)
}

export interface InterestRateCapInput {
  creditType: NcaCreditType
  interestRatePm: number
  interestModel: string
  /** Annual decimal (0.07 = 7%); null when no approved repo rate is recorded. */
  repoAnnualRate: number | null
}

export type InterestRateCapResult =
  | { ok: true }
  | { ok: false; reason: "ABOVE_CAP" | "NO_REPO_RATE"; message: string }

// Float tolerance: 0.0233 x 12 must not fail a 27.96% cap by a rounding hair.
const EPSILON = 1e-9

export function checkNcaInterestRate(input: InterestRateCapInput): InterestRateCapResult {
  const type = NCA_CREDIT_TYPE_LABELS[input.creditType]
  if (input.creditType === "SHORT_TERM") {
    const cap = NCA_INTEREST_CAP.shortTermMonthlyRate
    return input.interestRatePm <= cap + EPSILON
      ? { ok: true }
      : {
          ok: false,
          reason: "ABOVE_CAP",
          message: `${(input.interestRatePm * 100).toFixed(2)}% per month exceeds the NCA maximum of ${(cap * 100).toFixed(2)}% per month for a ${type} (Regulation 42).`,
        }
  }
  if (input.repoAnnualRate === null) {
    return {
      ok: false,
      reason: "NO_REPO_RATE",
      message: `The NCA maximum for an ${type} is the repo rate + 21% per year, and no approved repo rate is recorded. Record the SARB repo rate under Asset finance → Reference rates first.`,
    }
  }
  const capPercent = (input.repoAnnualRate + NCA_INTEREST_CAP.unsecuredRepoMargin) * 100
  const annual = annualisedInterestRate({ interestRatePm: input.interestRatePm, interestModel: input.interestModel })
  return annual.percent <= capPercent + EPSILON
    ? { ok: true }
    : {
        ok: false,
        reason: "ABOVE_CAP",
        message: `${annual.percent.toFixed(2)}% ${annual.basisLabel} exceeds the NCA maximum of ${capPercent.toFixed(2)}% (repo ${(input.repoAnnualRate * 100).toFixed(2)}% + 21%) for an ${type} (Regulation 42).`,
      }
}
