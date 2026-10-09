// Quoting from an insurer's supplied rate card.
//
// The lender is a PURE INTERMEDIARY. Nothing here derives a price: every premium
// returned is a row the insurer supplied, or — for PER_MILLE — that row's rate
// applied to the requested cover exactly as the insurer specified. There is no
// loading, no discount, and no fallback rate.
//
// This module is PURE: no Prisma, no I/O, and no `new Date()`. Ages are
// computed against a CALLER-SUPPLIED effective date so a quote is reproducible
// and a test can pin it. Money is integer cents throughout — see
// `lib/insurance/rand-cents.ts` for that decision.
//
// THE CENTRAL SAFETY RULE: no path returns a non-positive premium. A life that
// matches no band is an explicit failure, and so is a life that matches a band
// which resolves to zero or less — whether the insurer's row was captured as
// 0.00, captured negative, or is a PER_MILLE rate whose product with the
// requested cover rounds below a cent. Matching a band is not the same as
// having a price: a zero would sell cover for free, and a quote that cannot be
// priced must refuse to price rather than under-price.

import type { InsuredLifeType, RateBasis } from "@prisma/client"
import { addCents, formatCents, mulDivCents, toCents, type MoneyInput } from "../rand-cents"
import { bandMatchAxes, type BandShape } from "./band-match"

/** One row of the insurer's rate card, as loaded by `rate-table.ts`. */
export interface RateBandInput extends BandShape {
  id: string
  premiumAmount: MoneyInput
}

export interface QuoteLifeInput {
  /** Caller's handle for this life; echoed back on results and failures. */
  ref: string
  lifeType: InsuredLifeType
  dateOfBirth: Date
  sumAssured: MoneyInput
}

export type RateFailureReason =
  | "NO_BANDS_CONFIGURED"
  | "NO_MATCHING_BAND"
  | "AMBIGUOUS_BANDS"
  | "INVALID_AGE"
  | "INVALID_SUM_ASSURED"
  | "NON_POSITIVE_PREMIUM"

export type RateLifeResult =
  | { ok: true; bandId: string; premium: string; premiumCents: number }
  | { ok: false; reason: RateFailureReason; detail: string; bandIds?: string[] }

export interface RatedLife {
  ref: string
  lifeType: InsuredLifeType
  ageAtEntry: number
  bandId: string
  premium: string
  premiumCents: number
  sumAssured: string
}

export interface QuoteFailure {
  ref: string | null
  lifeType: InsuredLifeType | null
  ageAtEntry: number | null
  reason: RateFailureReason | "NO_LIVES" | "DUPLICATE_LIFE_REF"
  detail: string
}

export type RateQuoteResult =
  | {
      ok: true
      perLife: RatedLife[]
      failures: QuoteFailure[]
      totalPremium: string
      totalPremiumCents: number
      totalSumAssured: string
      totalSumAssuredCents: number
    }
  // No totals on this branch, deliberately: TypeScript then refuses to let a
  // caller read a total off a quote that failed to price every life.
  | { ok: false; perLife: RatedLife[]; failures: QuoteFailure[] }

/** Completed years from `dateOfBirth` to `at`, in UTC calendar terms. */
export function ageAtDate(dateOfBirth: Date, at: Date): number {
  if (Number.isNaN(dateOfBirth.getTime()) || Number.isNaN(at.getTime())) {
    throw new Error("ageAtDate requires two valid dates")
  }
  let age = at.getUTCFullYear() - dateOfBirth.getUTCFullYear()
  const monthDelta = at.getUTCMonth() - dateOfBirth.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < dateOfBirth.getUTCDate())) {
    age -= 1
  }
  if (age < 0) {
    throw new Error("Date of birth is not before the effective date")
  }
  return age
}

/**
 * Look up one life's premium on the insurer's rate card.
 *
 * Matching differs by basis, and WHICH keys each basis matches on is defined
 * once in `band-match.ts` — not restated here. The rate-band write path derives
 * its overlap refusal from the same axes, so a configuration it accepts is one
 * this function can price. (Only the arithmetic is per-basis here: PER_MILLE
 * premium = rate x sumAssured / 1000, every other basis takes the row as given.)
 *
 * More than one match is an error, not a first-match win: overlapping bands
 * mean the configuration is ambiguous and a human must resolve it before a
 * price is quoted.
 */
export function rateLife(
  bands: RateBandInput[],
  basis: RateBasis,
  lifeType: InsuredLifeType,
  ageAtEntry: number,
  sumAssured: MoneyInput,
): RateLifeResult {
  if (bands.length === 0) {
    return { ok: false, reason: "NO_BANDS_CONFIGURED", detail: "The rate table has no bands" }
  }
  if (!Number.isInteger(ageAtEntry) || ageAtEntry < 0) {
    return { ok: false, reason: "INVALID_AGE", detail: `Age at entry ${String(ageAtEntry)} is not a whole non-negative year` }
  }

  let sumAssuredCents: number
  try {
    sumAssuredCents = toCents(sumAssured)
  } catch (error) {
    return { ok: false, reason: "INVALID_SUM_ASSURED", detail: (error as Error).message }
  }
  if (sumAssuredCents <= 0) {
    return { ok: false, reason: "INVALID_SUM_ASSURED", detail: "Sum assured must be greater than zero" }
  }

  const axes = bandMatchAxes(basis)
  const matches = bands.filter((band) => {
    if (band.lifeType !== lifeType) return false
    if (axes.age && (ageAtEntry < band.minAge || ageAtEntry > band.maxAge)) return false
    if (axes.cover && toCents(band.sumAssured) !== sumAssuredCents) return false
    return true
  })

  if (matches.length === 0) {
    return {
      ok: false,
      reason: "NO_MATCHING_BAND",
      detail: `No ${basis} band covers a ${lifeType} aged ${ageAtEntry} for ${formatCents(sumAssuredCents)}`,
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS_BANDS",
      detail: `${matches.length} bands cover a ${lifeType} aged ${ageAtEntry} for ${formatCents(sumAssuredCents)}`,
      bandIds: matches.map((band) => band.id),
    }
  }

  const band = matches[0]
  const bandPremiumCents = toCents(band.premiumAmount)
  const premiumCents =
    basis === "PER_MILLE"
      // The band premium is per R1 000 of cover. Both operands are cents, so
      // the divisor is 1 000 rand expressed in cents, times the extra 100 that
      // the second operand's cents contribute.
      ? mulDivCents(bandPremiumCents, sumAssuredCents, 100_000)
      : bandPremiumCents

  // A matched band is not yet a price. Zero sells cover for free and a negative
  // premium pays the client to be insured; a PER_MILLE rate can also round
  // below a cent on a small enough sum assured. All three refuse here.
  if (premiumCents <= 0) {
    return {
      ok: false,
      reason: "NON_POSITIVE_PREMIUM",
      detail: `Band ${band.id} resolves to a premium of ${formatCents(premiumCents)} for a ${lifeType} aged ${ageAtEntry} covered for ${formatCents(sumAssuredCents)}`,
      bandIds: [band.id],
    }
  }

  return { ok: true, bandId: band.id, premium: formatCents(premiumCents), premiumCents }
}

/**
 * Rate every life on a quote. The quote succeeds only if every life prices;
 * a partially-rated quote exposes no total, because a total that silently
 * omits an unrateable life is exactly the under-price this module exists to
 * prevent.
 */
export function rateQuote(
  bands: RateBandInput[],
  basis: RateBasis,
  lives: QuoteLifeInput[],
  effectiveDate: Date,
): RateQuoteResult {
  const perLife: RatedLife[] = []
  const failures: QuoteFailure[] = []

  if (lives.length === 0) {
    return {
      ok: false,
      perLife,
      failures: [{ ref: null, lifeType: null, ageAtEntry: null, reason: "NO_LIVES", detail: "A quote must cover at least one life" }],
    }
  }

  const seenRefs = new Set<string>()

  for (const life of lives) {
    if (seenRefs.has(life.ref)) {
      failures.push({
        ref: life.ref,
        lifeType: life.lifeType,
        ageAtEntry: null,
        reason: "DUPLICATE_LIFE_REF",
        detail: `Life ref "${life.ref}" appears more than once`,
      })
      continue
    }
    seenRefs.add(life.ref)

    let ageAtEntry: number
    try {
      ageAtEntry = ageAtDate(life.dateOfBirth, effectiveDate)
    } catch (error) {
      failures.push({
        ref: life.ref,
        lifeType: life.lifeType,
        ageAtEntry: null,
        reason: "INVALID_AGE",
        detail: (error as Error).message,
      })
      continue
    }

    const rated = rateLife(bands, basis, life.lifeType, ageAtEntry, life.sumAssured)
    if (!rated.ok) {
      failures.push({ ref: life.ref, lifeType: life.lifeType, ageAtEntry, reason: rated.reason, detail: rated.detail })
      continue
    }

    perLife.push({
      ref: life.ref,
      lifeType: life.lifeType,
      ageAtEntry,
      bandId: rated.bandId,
      premium: rated.premium,
      premiumCents: rated.premiumCents,
      sumAssured: formatCents(toCents(life.sumAssured)),
    })
  }

  if (failures.length > 0) {
    return { ok: false, perLife, failures }
  }

  const totalPremiumCents = addCents(...perLife.map((life) => life.premiumCents))
  const totalSumAssuredCents = addCents(...perLife.map((life) => toCents(life.sumAssured)))

  return {
    ok: true,
    perLife,
    failures,
    totalPremium: formatCents(totalPremiumCents),
    totalPremiumCents,
    totalSumAssured: formatCents(totalSumAssuredCents),
    totalSumAssuredCents,
  }
}
