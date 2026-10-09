export function calculateCreditLifePremiumPeriodsForSchedule(
  scheduleLength: number,
  termDays: number,
): number {
  if (
    !Number.isSafeInteger(scheduleLength)
    || scheduleLength <= 0
    || !Number.isSafeInteger(termDays)
    || termDays <= 0
  ) {
    throw new RangeError("Credit-life term or schedule is outside the supported range")
  }
  // The product is sold as a monthly premium. Every begun 30-day cover period
  // is therefore a billed period; rounding to the nearest month left a
  // 31-44-day insured tail with no premium. A repayment schedule may contain
  // more rows than the 30-day periods, so it remains the lower bound.
  return Math.max(1, Math.ceil(termDays / 30), scheduleLength)
}

/**
 * Bind every monthly cover period to a real repayment row. Bullet products may
 * have several cover periods but one payment date, so the bullet collects all
 * premiums instead of leaving them outside the contractual ledger.
 */
export function creditLifePremiumsByInstallment(args: {
  scheduleLength: number
  premiumPeriods: number
  monthlyPremiumCents: number
  accepted: boolean
}): number[] {
  if (
    !Number.isSafeInteger(args.scheduleLength)
    || args.scheduleLength <= 0
    || !Number.isSafeInteger(args.premiumPeriods)
    || args.premiumPeriods < args.scheduleLength
    || !Number.isSafeInteger(args.monthlyPremiumCents)
    || args.monthlyPremiumCents < 0
    // "No credit-life cover was offered" is a first-class state, not a corrupt
    // one: the tenant has no active CREDIT_LIFE product, so the application
    // carries election=DECLINED with a premium of exactly 0 and no product —
    // the shape the LoanApplication_credit_life_election_complete CHECK
    // explicitly admits ('credit-life-no-offer-v1') and that
    // createPasqBillingEvidence already validates via its `offered` flag.
    //
    // Demanding a positive premium unconditionally threw before the
    // `if (!args.accepted) return zeros` line below could run, so PASQ
    // generation 500'd for every declined application and none could be
    // approved. A premium is only required when cover was actually ACCEPTED.
    || (args.accepted && args.monthlyPremiumCents <= 0)
  ) {
    throw new RangeError("Credit-life billing inputs are outside the supported range")
  }
  if (!args.accepted) return Array(args.scheduleLength).fill(0) as number[]

  const basePeriods = Math.floor(args.premiumPeriods / args.scheduleLength)
  const remainder = args.premiumPeriods % args.scheduleLength
  return Array.from({ length: args.scheduleLength }, (_, index) => {
    const periods = basePeriods + (index < remainder ? 1 : 0)
    const amount = periods * args.monthlyPremiumCents
    if (!Number.isSafeInteger(amount)) {
      throw new RangeError("Credit-life premium allocation exceeds the supported range")
    }
    return amount
  })
}

export function creditLifePremiumPaymentLoadCents(args: {
  scheduleLength: number
  premiumPeriods: number
  monthlyPremiumCents: number
  accepted: boolean
}): number {
  return Math.max(0, ...creditLifePremiumsByInstallment(args))
}
