// Annualising the contractual interest rate — derived from the product's
// interest MODEL, never hardcoded.
//
// Every disclosure surface (application screen, PASQ, credit agreement,
// statement) previously carried its own `Math.pow(1 + interestRatePm, 12) - 1`.
// That formula compounds the monthly rate, which is correct for an amortising
// REDUCING_BALANCE loan but wrong for the short-term products, where interest
// is a single simple charge that is never capitalised:
//
//   lib/loan-calculator.ts, FLAT and DAILY_ACCRUAL:
//     totalInterest = principal x (interestRatePm / 30) x termDays
//
// A 30-day Micro Loan at 5% charges R150 on R3,000 — once. There is no month-2
// balance for interest to accrue on, so quoting (1.05)^12 - 1 = 79.6% described
// a facility the lender does not offer and OVERSTATED the rate by ~19 points on
// a mandated NCA disclosure. The simple annualisation of that same daily rate is
// 60.8%.
//
// Because this number appears on NCA documents, it must be computed in exactly
// one place and follow the product configuration. Add a new InterestModel to
// the schema and `annualisedInterestRate` will throw rather than silently
// annualise it on the wrong basis.

// Every product annualises on a NOMINAL basis.
// The arithmetic still differs by model because the billing does, but the basis
// does not — so the figures are comparable across products, which is the only
// job this number has.
export type AnnualisationBasis = "nominal"

export type AnnualisedRate = {
  /** Annual interest rate as a percentage, e.g. 60.83. */
  percent: number
  /** How it was derived — compounding vs simple. */
  basis: AnnualisationBasis
  /** Consumer-facing suffix, e.g. "per year (simple)". */
  basisLabel: string
}

const DAYS_PER_MONTH = 30
const DAYS_PER_YEAR = 365

export function annualisedInterestRate(opts: {
  interestRatePm: number
  interestModel: string
}): AnnualisedRate {
  const { interestRatePm, interestModel } = opts

  switch (interestModel) {
    case "REDUCING_BALANCE":
      // Nominal annual rate: the monthly periodic rate x 12.
      //
      // NOT the effective (1+i)^12 - 1 = 42.6%. NCA Reg 42 expresses its caps
      // as nominal rates — short-term per MONTH, unsecured as an annual
      // percentage derived from repo — so a nominal figure is the one that can
      // be checked against the cap without conversion, and the one that is
      // comparable to the short-term products below.
      //
      // This does understate a genuinely compounding loan (36.0% nominal vs
      // 42.6% effective). That is acceptable ONLY because the annual rate is no
      // longer the disclosure of record: every document now itemises interest,
      // initiation fee and service fees, states the total cost of credit in
      // rands, and states the cost over the actual term.
      return {
        percent: interestRatePm * 12 * 100,
        basis: "nominal",
        basisLabel: "per year (nominal)",
      }

    case "FLAT":
    case "DAILY_ACCRUAL":
      // Interest is principal x daily rate x days, charged once and never
      // capitalised. Annualise the same DAILY rate the calculator bills on —
      // (i/30) x 365, not i x 12, because a 365-day term actually bills 60.83%
      // and i x 12 = 60.0% would understate it. Do NOT compound: that would
      // quote a cost the consumer cannot incur.
      return {
        percent: (interestRatePm / DAYS_PER_MONTH) * DAYS_PER_YEAR * 100,
        basis: "nominal",
        basisLabel: "per year (nominal)",
      }

    default:
      // Fail loudly. Silently defaulting would put an unverified rate on an NCA
      // document, which is precisely the failure this module exists to prevent.
      throw new Error(
        `annualisedInterestRate: unsupported interestModel "${interestModel}" — ` +
          `add an explicit annualisation basis before this rate reaches a consumer document`,
      )
  }
}

/** e.g. "60.8% per year (simple)" — the full annual-rate phrase. */
export function formatAnnualisedRate(opts: { interestRatePm: number; interestModel: string }): string {
  const a = annualisedInterestRate(opts)
  return `${a.percent.toFixed(1)}% ${a.basisLabel}`
}

/**
 * The interest actually charged over THIS loan's term, as a percentage of
 * principal. This is the number the consumer pays — a 30-day loan at 5% per
 * month costs 5%, not the annualised figure — so it belongs beside the annual
 * rate on any quote or agreement.
 *
 * Derived from the calculator's own output rather than re-deriving the formula,
 * so it cannot drift from what is actually billed.
 */
export function termInterestPercent(opts: { principal: number; totalInterest: number }): number {
  if (opts.principal <= 0) return 0
  return (opts.totalInterest / opts.principal) * 100
}
