// app/api/insurance/rate-tables/band-input.ts
//
// Shared input parsing for rate bands, used by both the collection route
// (POST a new band) and the item route (PATCH an existing one). It lives here
// rather than being written twice because the PATCH path validates the MERGED
// band — a caller who only sends `maxAge` can still invert the range or
// collide with a sibling, and a second copy of these rules would drift.
import { InsuredLifeType } from "@prisma/client"
import type { RateBasis } from "@prisma/client"
import { bandMatchAxes } from "@/lib/insurance/rating/band-match"
import { parseDecimalAmount, toStoredScale, DECIMAL_12_2_MAX_CENTS } from "../decimal-input"

export type BandInput = {
  lifeType: InsuredLifeType
  minAge: number
  maxAge: number
  sumAssured: number
  premiumAmount: number
}

const LIFE_TYPES = Object.values(InsuredLifeType) as string[]

// An age is stored in an `Int` column, so an unbounded value reaches Postgres
// as `integer out of range` — a 500 the caller cannot act on. 120 is the
// ceiling because no insurable life exceeds it; the point is to have a bound at
// all, well below int32, so the refusal happens here.
const MAX_AGE = 120

function isAge(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_AGE
}

/**
 * Resolve a band from a request body, layering it over `base` when one is
 * supplied (the PATCH case). Returns the fully-validated band or the reason
 * it was refused — never a partially-checked value.
 *
 * `premiumAmount` and `sumAssured` must be strictly positive AT THE SCALE THE
 * COLUMN STORES THEM. A zero or negative premium is not a rounding artefact: it
 * is a rate card that hands out cover for nothing, and it must be impossible to
 * enter, not merely caught downstream at quote time. R0.001 is the same defect
 * wearing a disguise — the column is `Decimal(12, 2)` and Postgres rounds it to
 * R0.00 rather than refusing it, so the validator has to be the thing that says
 * no.
 */
export function parseBandInput(
  body: Record<string, unknown>,
  base?: BandInput
): { ok: true; value: BandInput } | { ok: false; error: string } {
  const lifeType = body.lifeType === undefined ? base?.lifeType : body.lifeType
  const minAge = body.minAge === undefined ? base?.minAge : body.minAge
  const maxAge = body.maxAge === undefined ? base?.maxAge : body.maxAge
  const sumAssured = body.sumAssured === undefined ? base?.sumAssured : body.sumAssured
  const premiumAmount = body.premiumAmount === undefined ? base?.premiumAmount : body.premiumAmount

  if (typeof lifeType !== "string" || !LIFE_TYPES.includes(lifeType)) {
    return { ok: false, error: `lifeType must be one of ${LIFE_TYPES.join(", ")}` }
  }
  if (!isAge(minAge) || !isAge(maxAge)) {
    return { ok: false, error: `minAge and maxAge must be integers between 0 and ${MAX_AGE}` }
  }
  if (minAge > maxAge) {
    return { ok: false, error: "minAge must not exceed maxAge" }
  }

  const cover = parseDecimalAmount("sumAssured", sumAssured, {
    maxCents: DECIMAL_12_2_MAX_CENTS,
  })
  if (!cover.ok) return cover

  const premium = parseDecimalAmount("premiumAmount", premiumAmount, {
    maxCents: DECIMAL_12_2_MAX_CENTS,
  })
  if (!premium.ok) return premium

  return {
    ok: true,
    value: {
      lifeType: lifeType as InsuredLifeType,
      minAge,
      maxAge,
      sumAssured: cover.value,
      premiumAmount: premium.value,
    },
  }
}

/**
 * The WHERE clause that finds a band already addressing some life this band
 * would also address. Ambiguous pricing has to be unconfigurable, not merely
 * detectable.
 *
 * WHICH KEYS COLLIDE IS THE BASIS'S ANSWER, NOT THIS FUNCTION'S. The axes come
 * from `bandMatchAxes`, the same table `rateLife` matches on, so the query
 * refuses exactly the pairs the rating path would call AMBIGUOUS_BANDS. Keying
 * every basis on `sumAssured` — which this did — let two PER_MILLE bands at
 * different cover amounts store, and PER_MILLE rating ignores a band's own
 * cover: every life on the table was then unquotable.
 *
 * Where the age axis applies, ranges are INCLUSIVE at both ends, so two bands
 * overlap when each starts at or before the other ends. Where the cover axis
 * applies, `sumAssured` is normalised to the stored 2dp scale first: the column
 * holds what Postgres rounded, so comparing a raw JS number against it would
 * let 30000.555 slip past an existing 30000.56.
 */
export function overlapWhere(
  rateTableId: string,
  basis: RateBasis,
  band: BandInput,
  excludeBandId?: string
) {
  const axes = bandMatchAxes(basis)
  return {
    rateTableId,
    lifeType: band.lifeType,
    ...(axes.cover ? { sumAssured: toStoredScale(band.sumAssured) } : {}),
    ...(axes.age ? { minAge: { lte: band.maxAge }, maxAge: { gte: band.minAge } } : {}),
    ...(excludeBandId ? { NOT: { id: excludeBandId } } : {}),
  } as {
    rateTableId: string
    lifeType: InsuredLifeType
    sumAssured?: number
    minAge?: { lte: number }
    maxAge?: { gte: number }
    NOT?: { id: string }
  }
}

/**
 * How to describe a refused overlap to the operator, in the terms the basis
 * actually matched on. Naming a cover tier under PER_MILLE would send them
 * looking for a difference that is not a difference.
 */
export function overlapDetail(basis: RateBasis, band: BandInput): string {
  const axes = bandMatchAxes(basis)
  const range = axes.age ? `ages ${band.minAge}-${band.maxAge}` : `every age`
  const cover = axes.cover
    ? `at cover ${band.sumAssured}`
    : `at any cover — a ${basis} rate applies across cover amounts, so the band's own sumAssured is not a tier key`
  return `${band.lifeType} over ${range} ${cover}`
}
