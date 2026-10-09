// Laying a rate card out as the grid an operator reads it as: life type ×
// age range × cover tier → premium.
//
// The band routes accept one row at a time and refuse a row that collides with
// a sibling. Neither of those says anything about the SHAPE of the finished
// card, and shape is what goes wrong in practice: a card whose MAIN_MEMBER
// bands run 18-30 and 36-65 stores without complaint, activates without
// complaint, reports the product sellable — and cannot price a 33-year-old.
// `rateLife` returns NO_MATCHING_BAND at quote time, which is the first moment
// anyone finds out.
//
// So this module answers the two questions the row-at-a-time API cannot:
// which cells of the card are EMPTY, and which are addressed TWICE. Which keys
// place a band in a cell is not decided here — it is `bandMatchAxes`'s answer,
// the same one the write path refuses overlaps by and the read path prices
// from, so a grid can never disagree with what the card will actually do.
//
// PURE: no Prisma, no I/O, no `new Date()`. Money arrives as rands and is
// compared in exact cents, never as a float.

import type { InsuredLifeType, RateBasis } from "@prisma/client"
import { toCents } from "../rand-cents"
import { bandMatchAxes, bandsCollide, INSURED_LIFE_TYPES } from "./band-match"

/** A band as the grid needs it: identified, and with money already in rands. */
export interface GridBand {
  id: string
  lifeType: InsuredLifeType
  minAge: number
  maxAge: number
  sumAssured: number
  premiumAmount: number
}

/** A row of the grid. `null` where the basis does not rate on age. */
export interface AgeRange {
  minAge: number
  maxAge: number
}

/** An age range no band prices, sitting BETWEEN two that do. */
export interface BandGap {
  lifeType: InsuredLifeType
  /** The cover tier the hole is in, or `null` where cover is not a tier key. */
  sumAssured: number | null
  minAge: number
  maxAge: number
}

export interface GridSection {
  lifeType: InsuredLifeType
  /** Columns, ascending. A single `null` column where cover is not a tier key. */
  coverTiers: (number | null)[]
  /** Rows, ascending by minAge. A single `null` row where age is not a rating factor. */
  ageRanges: (AgeRange | null)[]
  /**
   * `cells[row][column]` — every band addressing that cell. Empty is a hole in
   * the card; more than one is an ambiguity the read path refuses to price.
   */
  cells: GridBand[][][]
  gaps: BandGap[]
}

export interface BandGrid {
  /** Only life types the card carries a band for, in schema order. */
  sections: GridSection[]
  /**
   * Life types the card carries NO band for, in schema order.
   *
   * Reported separately rather than left out, because leaving them out is what
   * made the worst shape of a broken card invisible: a card with MAIN_MEMBER
   * bands and nothing for SPOUSE renders complete and contiguous, every cell
   * filled, no gap and no overlap. Life type is the one key every basis matches
   * on, so `rateLife` returns NO_MATCHING_BAND for an absent type whatever the
   * age or cover — the card cannot price a spouse at all. `canSellProduct` does
   * catch it, but only on a different screen, so an operator can finish here
   * believing the card is done.
   */
  unpriceableLifeTypes: InsuredLifeType[]
  /** Every pair of bands that both address some (life type, age, cover). */
  overlaps: [GridBand, GridBand][]
}

function sameAgeRange(a: AgeRange, b: AgeRange): boolean {
  return a.minAge === b.minAge && a.maxAge === b.maxAge
}

/**
 * Build the grid for a card.
 *
 * The axes come from the basis, so a FLAT card renders one row (age is not a
 * rating factor) and a PER_MILLE card renders one column (the rate applies
 * across cover amounts, so a band's own `sumAssured` is not a tier key).
 * Rendering a PER_MILLE card with a column per cover amount would show an
 * operator four distinct tiers where the rating path sees one, and every one of
 * them ambiguous.
 */
export function buildBandGrid(basis: RateBasis, bands: readonly GridBand[]): BandGrid {
  const axes = bandMatchAxes(basis)

  const sections: GridSection[] = []
  for (const lifeType of INSURED_LIFE_TYPES) {
    const own = bands.filter((band) => band.lifeType === lifeType)
    if (own.length === 0) continue

    const coverTiers: (number | null)[] = axes.cover
      ? [...new Set(own.map((band) => toCents(band.sumAssured)))]
          .sort((a, b) => a - b)
          .map((cents) => cents / 100)
      : [null]

    const ageRanges: (AgeRange | null)[] = axes.age
      ? own
          .map((band): AgeRange => ({ minAge: band.minAge, maxAge: band.maxAge }))
          .filter((range, i, all) => all.findIndex((other) => sameAgeRange(other, range)) === i)
          .sort((a, b) => a.minAge - b.minAge || a.maxAge - b.maxAge)
      : [null]

    const cells = ageRanges.map((range) =>
      coverTiers.map((cover) =>
        own.filter(
          (band) =>
            (cover === null || toCents(band.sumAssured) === toCents(cover)) &&
            (range === null || sameAgeRange(band, range))
        )
      )
    )

    sections.push({ lifeType, coverTiers, ageRanges, cells, gaps: findGaps(axes.age, lifeType, coverTiers, own) })
  }

  const overlaps: [GridBand, GridBand][] = []
  for (let i = 0; i < bands.length; i += 1) {
    for (let j = i + 1; j < bands.length; j += 1) {
      if (bandsCollide(basis, bands[i], bands[j])) overlaps.push([bands[i], bands[j]])
    }
  }

  const priced = new Set(sections.map((section) => section.lifeType))
  const unpriceableLifeTypes = INSURED_LIFE_TYPES.filter((lifeType) => !priced.has(lifeType))

  return { sections, unpriceableLifeTypes, overlaps }
}

/**
 * The uncovered age ranges inside a column, and only the INTERIOR ones.
 *
 * A card that starts at 18 is not missing ages 0-17 — an insurer's minimum
 * entry age is an eligibility rule, not a hole in the rate card, and reporting
 * it here would bury the real defect under a warning on every column. What is
 * always a defect is an age BETWEEN two priced ranges: the operator has already
 * said this column prices from 18 to 65, and 31-35 falling out of it prices
 * nothing.
 */
function findGaps(
  ratesOnAge: boolean,
  lifeType: InsuredLifeType,
  coverTiers: (number | null)[],
  bands: readonly GridBand[]
): BandGap[] {
  if (!ratesOnAge) return []

  const gaps: BandGap[] = []
  for (const cover of coverTiers) {
    const column = bands
      .filter((band) => cover === null || toCents(band.sumAssured) === toCents(cover))
      .sort((a, b) => a.minAge - b.minAge || a.maxAge - b.maxAge)

    // `reach` is the highest age priced so far, not the previous band's own
    // maxAge: 18-65 followed by 20-30 is fully covered, and comparing against
    // the last band alone would report 31-... as a hole in it.
    let reach = column.length > 0 ? column[0].maxAge : 0
    for (const band of column.slice(1)) {
      if (band.minAge > reach + 1) {
        gaps.push({ lifeType, sumAssured: cover, minAge: reach + 1, maxAge: band.minAge - 1 })
      }
      reach = Math.max(reach, band.maxAge)
    }
  }
  return gaps
}
