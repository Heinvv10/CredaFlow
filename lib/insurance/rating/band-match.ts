// When do two rows of an insurer's rate card address the same life?
//
// THIS FILE IS THE ONLY ANSWER. Two places need it and they must never drift:
//
//   - the READ path (`rateLife`) picks the band that matches a requested
//     (life type, age, cover) and refuses to price when more than one does;
//   - the WRITE path (`overlapWhere` in the rate-band routes) refuses to store
//     a band that would collide with one already on the table.
//
// They drifted once, and the failure was total rather than partial: the write
// path keyed a collision on `sumAssured` for every basis, while PER_MILLE
// rating ignores a band's own `sumAssured` — the rate applies across cover
// amounts. Two MAIN_MEMBER 18-65 bands at R10 000 and R20 000 therefore both
// stored, and afterwards EVERY life on that table quoted AMBIGUOUS_BANDS while
// readiness still reported the product sellable.
//
// The rule is expressed here as the set of AXES a basis matches on, so the
// question "do these two bands both match some (life type, age, cover)?" has
// one implementation and the Prisma WHERE clause is derived from the same
// facts rather than restating them.

import type { InsuredLifeType, RateBasis } from "@prisma/client"
import { toCents, type MoneyInput } from "../rand-cents"

/** The fields of a band that decide which lives it addresses. */
export interface BandShape {
  lifeType: InsuredLifeType
  minAge: number
  maxAge: number
  sumAssured: MoneyInput
}

/**
 * Which of a band's keys the basis actually matches on. Life type is matched
 * under every basis, so it is not an axis — it is the constant.
 */
export interface BandMatchAxes {
  /** The requested age must fall inside [minAge, maxAge]. */
  age: boolean
  /** The requested cover must equal the band's `sumAssured` exactly. */
  cover: boolean
}

/**
 * AGE_BANDED — an age band per cover tier, so both axes key.
 * FLAT        — one premium per cover tier; age is not a rating factor.
 * PER_MILLE   — a rate per R1 000 that applies across cover amounts, so the
 *               band's own `sumAssured` is not a tier key.
 *
 * `Record<RateBasis, …>` rather than a switch, so adding a basis to the schema
 * fails the type check here instead of silently taking a default.
 */
const BAND_MATCH_AXES: Record<RateBasis, BandMatchAxes> = {
  AGE_BANDED: { age: true, cover: true },
  FLAT: { age: false, cover: true },
  PER_MILLE: { age: true, cover: false },
}

/**
 * The axes this basis matches on.
 *
 * A value the enum has gained without this table being updated cannot reach
 * here past the type check, but if one did at runtime it falls back to matching
 * on life type ALONE. That is the fail-closed direction: every band of a life
 * type then collides, so the write path refuses to store a second one and the
 * read path reports AMBIGUOUS_BANDS rather than quoting a price nobody chose.
 */
export function bandMatchAxes(basis: RateBasis): BandMatchAxes {
  return BAND_MATCH_AXES[basis] ?? { age: false, cover: false }
}

/**
 * Do these two bands both match some (life type, age, cover) request?
 *
 * Age ranges are CLOSED at both ends, so two bands overlap when each starts at
 * or before the other ends — 18-30 and 30-65 collide on the year 30.
 */
export function bandsCollide(basis: RateBasis, a: BandShape, b: BandShape): boolean {
  if (a.lifeType !== b.lifeType) return false

  const axes = bandMatchAxes(basis)
  if (axes.age && (a.minAge > b.maxAge || b.minAge > a.maxAge)) return false
  if (axes.cover && toCents(a.sumAssured) !== toCents(b.sumAssured)) return false
  return true
}

/**
 * The first pair of bands on a card that address the same life, or null.
 *
 * Used where a whole card has to be judged at once rather than one candidate
 * band against its siblings: changing a DRAFT table's `basis` re-keys every
 * band it already holds, so rows that were unambiguous under the old basis can
 * become ambiguous under the new one without a single band being written.
 *
 * Pairwise on purpose. A rate card is a handful of rows per life type, and an
 * index keyed by basis would have to be rebuilt per basis anyway.
 */
export function firstCollision<T extends BandShape & { id: string }>(
  basis: RateBasis,
  bands: readonly T[],
): [T, T] | null {
  for (let i = 0; i < bands.length; i += 1) {
    for (let j = i + 1; j < bands.length; j += 1) {
      if (bandsCollide(basis, bands[i], bands[j])) return [bands[i], bands[j]]
    }
  }
  return null
}

/**
 * The life types this rate card carries a band for, in schema order.
 *
 * A life type absent from this list cannot be priced under ANY basis: life type
 * is the one key every basis matches on, so `rateLife` returns NO_MATCHING_BAND
 * for it whatever the age or cover requested. `product-readiness.ts` uses that
 * to refuse to call a product sellable when a life it screens cannot be priced.
 */
export function lifeTypesWithBands(bands: readonly Pick<BandShape, "lifeType">[]): InsuredLifeType[] {
  const present = new Set(bands.map((band) => band.lifeType))
  return INSURED_LIFE_TYPES.filter((lifeType) => present.has(lifeType))
}

/**
 * Every life type a quote can carry. Hand-written so this module imports
 * nothing from the generated client at runtime; `product-readiness.ts`
 * re-exports it and a test there compares it against the Prisma enum, so it
 * cannot drift silently.
 */
export const INSURED_LIFE_TYPES = [
  "MAIN_MEMBER",
  "SPOUSE",
  "CHILD",
  "EXTENDED_FAMILY",
] as const satisfies readonly InsuredLifeType[]
