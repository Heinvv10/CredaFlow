// Fixtures here are deliberately NON-UNIFORM. A card whose bands all carry the
// same ages and the same cover proves nothing about a grid: every cell would be
// identical, so a builder that dropped the cover axis, dropped the age axis, or
// put every band in one cell would pass. Each fixture below differs on the axis
// the assertion is about.
import { describe, expect, it } from "vitest"
import { buildBandGrid, type GridBand } from "./band-grid"

function band(
  id: string,
  lifeType: GridBand["lifeType"],
  minAge: number,
  maxAge: number,
  sumAssured: number,
  premiumAmount: number
): GridBand {
  return { id, lifeType, minAge, maxAge, sumAssured, premiumAmount }
}

/**
 * A realistic funeral card: two cover tiers, three age bands that are NOT the
 * same across the tiers, a spouse rated differently from the main member, and a
 * child priced flat across one wide age band.
 */
const CARD: GridBand[] = [
  band("m-18-40-10k", "MAIN_MEMBER", 18, 40, 10000, 45),
  band("m-41-65-10k", "MAIN_MEMBER", 41, 65, 10000, 88),
  band("m-18-40-20k", "MAIN_MEMBER", 18, 40, 20000, 82),
  band("m-41-65-20k", "MAIN_MEMBER", 41, 65, 20000, 171.5),
  band("s-18-65-10k", "SPOUSE", 18, 65, 10000, 39),
  band("c-0-21-5k", "CHILD", 0, 21, 5000, 12.5),
]

describe("buildBandGrid — AGE_BANDED", () => {
  const grid = buildBandGrid("AGE_BANDED", CARD)

  it("sections only the life types the card prices, in schema order", () => {
    expect(grid.sections.map((s) => s.lifeType)).toEqual(["MAIN_MEMBER", "SPOUSE", "CHILD"])
  })

  it("keys columns on cover and rows on age, both ascending", () => {
    const main = grid.sections[0]
    expect(main.coverTiers).toEqual([10000, 20000])
    expect(main.ageRanges).toEqual([
      { minAge: 18, maxAge: 40 },
      { minAge: 41, maxAge: 65 },
    ])
  })

  it("places each band in the cell its own age range and cover tier name", () => {
    const main = grid.sections[0]
    // Read the whole grid as ids so a builder that put every band in one cell,
    // or transposed the axes, cannot pass.
    const ids = main.cells.map((row) => row.map((cell) => cell.map((b) => b.id)))
    expect(ids).toEqual([
      [["m-18-40-10k"], ["m-18-40-20k"]],
      [["m-41-65-10k"], ["m-41-65-20k"]],
    ])
  })

  it("prices the same age range differently in different cover tiers", () => {
    const main = grid.sections[0]
    expect(main.cells[0][0][0].premiumAmount).toBe(45)
    expect(main.cells[0][1][0].premiumAmount).toBe(82)
  })

  it("reports no gaps and no overlaps for a contiguous card", () => {
    expect(grid.sections.flatMap((s) => s.gaps)).toEqual([])
    expect(grid.overlaps).toEqual([])
  })

  it("leaves a cell empty where a cover tier has no band at that age range", () => {
    // The spouse tier carries 10k at 18-65; a 20k spouse band at 18-40 only
    // adds a column, so the 41-65 row of that column must be a hole.
    const partial = buildBandGrid("AGE_BANDED", [
      band("s-18-65-10k", "SPOUSE", 18, 65, 10000, 39),
      band("s-18-40-20k", "SPOUSE", 18, 40, 20000, 71),
    ])
    const spouse = partial.sections[0]
    expect(spouse.coverTiers).toEqual([10000, 20000])
    expect(spouse.ageRanges).toEqual([
      { minAge: 18, maxAge: 40 },
      { minAge: 18, maxAge: 65 },
    ])
    const ids = spouse.cells.map((row) => row.map((cell) => cell.map((b) => b.id)))
    expect(ids).toEqual([
      [[], ["s-18-40-20k"]],
      [["s-18-65-10k"], []],
    ])
  })
})

describe("buildBandGrid — interior age gaps", () => {
  it("names the ages left unpriced between two bands of one cover tier", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 36, 65, 10000, 90),
    ])
    expect(grid.sections[0].gaps).toEqual([
      { lifeType: "MAIN_MEMBER", sumAssured: 10000, minAge: 31, maxAge: 35 },
    ])
  })

  it("does not call the ages below the first band a gap", () => {
    // 0-17 is an entry-age rule, not a hole in the card.
    const grid = buildBandGrid("AGE_BANDED", [band("a", "MAIN_MEMBER", 18, 65, 10000, 45)])
    expect(grid.sections[0].gaps).toEqual([])
  })

  it("treats abutting ranges as contiguous", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 31, 65, 10000, 90),
    ])
    expect(grid.sections[0].gaps).toEqual([])
  })

  it("finds a gap in one cover tier while the other is contiguous", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 31, 65, 10000, 90),
      band("c", "MAIN_MEMBER", 18, 30, 20000, 82),
      band("d", "MAIN_MEMBER", 40, 65, 20000, 170),
    ])
    expect(grid.sections[0].gaps).toEqual([
      { lifeType: "MAIN_MEMBER", sumAssured: 20000, minAge: 31, maxAge: 39 },
    ])
  })

  it("does not report a hole inside a range a wider band already covers", () => {
    // 18-65 followed by 20-30: comparing only against the PREVIOUS band's
    // maxAge would invent a 31-... gap that is not one.
    const grid = buildBandGrid("AGE_BANDED", [
      band("wide", "MAIN_MEMBER", 18, 65, 10000, 45),
      band("inner", "MAIN_MEMBER", 20, 30, 10000, 50),
    ])
    expect(grid.sections[0].gaps).toEqual([])
  })
})

describe("buildBandGrid — overlaps", () => {
  it("reports two bands that both price an age in one cover tier", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 30, 65, 10000, 90),
    ])
    expect(grid.overlaps.map(([x, y]) => [x.id, y.id])).toEqual([["a", "b"]])
  })

  it("does not call two bands overlapping when they sit in different cover tiers", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 65, 10000, 45),
      band("b", "MAIN_MEMBER", 18, 65, 20000, 90),
    ])
    expect(grid.overlaps).toEqual([])
  })

  it("does not call two bands overlapping across life types", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 65, 10000, 45),
      band("b", "SPOUSE", 18, 65, 10000, 39),
    ])
    expect(grid.overlaps).toEqual([])
  })
})

describe("buildBandGrid — the basis decides the axes", () => {
  it("PER_MILLE renders one cover column, because cover is not a tier key", () => {
    // The same two bands are two tiers under AGE_BANDED and one ambiguity under
    // PER_MILLE. Showing an operator two distinct PER_MILLE tiers would show
    // them a card the rating path cannot quote at all.
    const bands = [
      band("a", "MAIN_MEMBER", 18, 40, 10000, 4.5),
      band("b", "MAIN_MEMBER", 18, 40, 20000, 4.5),
    ]
    const grid = buildBandGrid("PER_MILLE", bands)
    expect(grid.sections[0].coverTiers).toEqual([null])
    expect(grid.sections[0].ageRanges).toEqual([{ minAge: 18, maxAge: 40 }])
    expect(grid.sections[0].cells[0][0].map((b) => b.id)).toEqual(["a", "b"])
    expect(grid.overlaps.map(([x, y]) => [x.id, y.id])).toEqual([["a", "b"]])

    expect(buildBandGrid("AGE_BANDED", bands).sections[0].coverTiers).toEqual([10000, 20000])
    expect(buildBandGrid("AGE_BANDED", bands).overlaps).toEqual([])
  })

  it("FLAT renders one age row and no age gaps, because age is not a rating factor", () => {
    const grid = buildBandGrid("FLAT", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 36, 65, 20000, 90),
    ])
    const main = grid.sections[0]
    expect(main.ageRanges).toEqual([null])
    expect(main.coverTiers).toEqual([10000, 20000])
    expect(main.cells.map((row) => row.map((cell) => cell.map((b) => b.id)))).toEqual([
      [["a"], ["b"]],
    ])
    // 31-35 is not a hole under FLAT — nothing rates on age.
    expect(main.gaps).toEqual([])
  })

  it("FLAT calls two bands at the same cover an overlap whatever their ages", () => {
    const grid = buildBandGrid("FLAT", [
      band("a", "MAIN_MEMBER", 18, 30, 10000, 45),
      band("b", "MAIN_MEMBER", 36, 65, 10000, 90),
    ])
    expect(grid.overlaps.map(([x, y]) => [x.id, y.id])).toEqual([["a", "b"]])
  })
})

describe("buildBandGrid — money is compared in cents", () => {
  it("does not split one cover tier in two over float representation", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("a", "MAIN_MEMBER", 18, 40, 10000.1, 45),
      band("b", "MAIN_MEMBER", 41, 65, 10000.1, 90),
    ])
    expect(grid.sections[0].coverTiers).toEqual([10000.1])
    expect(grid.sections[0].cells.map((row) => row[0].map((b) => b.id))).toEqual([["a"], ["b"]])
  })
})

describe("buildBandGrid — empty card", () => {
  it("has no sections and no overlaps, and can price nothing at all", () => {
    expect(buildBandGrid("AGE_BANDED", [])).toEqual({
      sections: [],
      unpriceableLifeTypes: ["MAIN_MEMBER", "SPOUSE", "CHILD", "EXTENDED_FAMILY"],
      overlaps: [],
    })
  })
})

// The worst shape a rate card takes, and the one every other check misses.
//
// A card with MAIN_MEMBER bands and nothing for SPOUSE has no gap, no overlap,
// and every cell of every section it renders is filled. It looks finished. Life
// type is the one key EVERY basis matches on, so `rateLife` returns
// NO_MATCHING_BAND for a spouse whatever the age or cover — the family quote in
// the walkthrough cannot be priced.
describe("buildBandGrid — life types the card cannot price at all", () => {
  it("names the life types with no band, while the card itself reports no fault", () => {
    const grid = buildBandGrid("AGE_BANDED", [
      band("m-18-40", "MAIN_MEMBER", 18, 40, 10000, 45),
      band("m-41-65", "MAIN_MEMBER", 41, 65, 10000, 88),
    ])
    // Contiguous, unambiguous — and unable to price three quarters of a family.
    expect(grid.sections.flatMap((s) => s.gaps)).toEqual([])
    expect(grid.overlaps).toEqual([])
    expect(grid.unpriceableLifeTypes).toEqual(["SPOUSE", "CHILD", "EXTENDED_FAMILY"])
  })

  it("is empty once every life type carries a band", () => {
    expect(buildBandGrid("AGE_BANDED", CARD).unpriceableLifeTypes).toEqual(["EXTENDED_FAMILY"])
    const full = buildBandGrid("AGE_BANDED", [
      ...CARD,
      band("e-18-75-5k", "EXTENDED_FAMILY", 18, 75, 5000, 60),
    ])
    expect(full.unpriceableLifeTypes).toEqual([])
  })

  it("reports in schema order, not the order bands happen to be entered", () => {
    const grid = buildBandGrid("AGE_BANDED", [band("c", "CHILD", 0, 21, 5000, 12.5)])
    expect(grid.unpriceableLifeTypes).toEqual(["MAIN_MEMBER", "SPOUSE", "EXTENDED_FAMILY"])
  })

  it("counts a life type as priceable under any basis, since life type is never an axis", () => {
    // FLAT does not rate on age and PER_MILLE does not tier on cover, but both
    // match on life type — so the answer must not depend on the basis.
    const bands = [band("s", "SPOUSE", 18, 65, 10000, 39)]
    for (const basis of ["AGE_BANDED", "FLAT", "PER_MILLE"] as const) {
      expect(buildBandGrid(basis, bands).unpriceableLifeTypes).toEqual([
        "MAIN_MEMBER",
        "CHILD",
        "EXTENDED_FAMILY",
      ])
    }
  })
})
