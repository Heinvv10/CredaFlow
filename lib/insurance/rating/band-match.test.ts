// lib/insurance/rating/band-match.test.ts
//
// The write path refuses overlapping bands and the read path refuses to price
// ambiguous ones. If those two disagree about what "the same life" means, a
// configuration the write path accepts becomes a quote the read path cannot
// produce — which is exactly what happened when the overlap check keyed on
// `sumAssured` while PER_MILLE rating ignored it. These tests hold the two
// definitions to the SAME rule.
import { describe, expect, it } from "vitest"
import type { RateBasis } from "@prisma/client"
import { bandMatchAxes, bandsCollide, lifeTypesWithBands, type BandShape } from "./band-match"
import { rateLife, type RateBandInput } from "./rate-quote"

const ALL_BASES: RateBasis[] = ["AGE_BANDED", "FLAT", "PER_MILLE"]

function band(overrides: Partial<BandShape> & { id?: string } = {}): RateBandInput {
  return {
    id: overrides.id ?? "b1",
    lifeType: overrides.lifeType ?? "MAIN_MEMBER",
    minAge: overrides.minAge ?? 18,
    maxAge: overrides.maxAge ?? 65,
    sumAssured: overrides.sumAssured ?? "10000.00",
    premiumAmount: "50.00",
  }
}

describe("bandMatchAxes", () => {
  it("keys AGE_BANDED on both age and cover", () => {
    expect(bandMatchAxes("AGE_BANDED")).toEqual({ age: true, cover: true })
  })

  it("keys FLAT on cover only — age is not a rating factor", () => {
    expect(bandMatchAxes("FLAT")).toEqual({ age: false, cover: true })
  })

  it("keys PER_MILLE on age only — the rate applies across cover amounts", () => {
    expect(bandMatchAxes("PER_MILLE")).toEqual({ age: true, cover: false })
  })
})

describe("bandsCollide", () => {
  it.each(ALL_BASES)("never collides two different life types (%s)", (basis) => {
    expect(bandsCollide(basis, band({ lifeType: "MAIN_MEMBER" }), band({ lifeType: "SPOUSE" }))).toBe(false)
  })

  it("collides two PER_MILLE bands at DIFFERENT cover amounts — the executed defect", () => {
    // Two MAIN_MEMBER 18-65 bands at R10 000 and R20 000. The old overlap check
    // keyed on sumAssured and let both in; rateLife ignores a PER_MILLE band's
    // own sumAssured, so every life on the table then quoted AMBIGUOUS_BANDS.
    const a = band({ id: "b1", sumAssured: "10000.00" })
    const b = band({ id: "b2", sumAssured: "20000.00" })

    expect(bandsCollide("PER_MILLE", a, b)).toBe(true)
    expect(bandsCollide("AGE_BANDED", a, b)).toBe(false)
  })

  it("collides two FLAT bands at the same cover whatever their age ranges", () => {
    const a = band({ id: "b1", minAge: 18, maxAge: 30 })
    const b = band({ id: "b2", minAge: 31, maxAge: 65 })

    expect(bandsCollide("FLAT", a, b)).toBe(true)
    expect(bandsCollide("AGE_BANDED", a, b)).toBe(false)
    expect(bandsCollide("PER_MILLE", a, b)).toBe(false)
  })

  it("treats age ranges as CLOSED intervals — touching at one year is a collision", () => {
    const a = band({ id: "b1", minAge: 18, maxAge: 30 })
    const b = band({ id: "b2", minAge: 30, maxAge: 65 })

    expect(bandsCollide("AGE_BANDED", a, b)).toBe(true)
    expect(bandsCollide("AGE_BANDED", a, band({ id: "b2", minAge: 31, maxAge: 65 }))).toBe(false)
  })

  it("compares cover exactly, not as a float", () => {
    expect(bandsCollide("AGE_BANDED", band({ sumAssured: "30000.50" }), band({ id: "b2", sumAssured: 30000.5 }))).toBe(true)
    expect(bandsCollide("AGE_BANDED", band({ sumAssured: "30000.50" }), band({ id: "b2", sumAssured: "30000.51" }))).toBe(false)
  })
})

describe("bandsCollide agrees with rateLife", () => {
  // The property that matters: if two bands collide, SOME quote matches both,
  // and rateLife reports AMBIGUOUS_BANDS rather than picking one. If they do
  // not collide, no quote can match both.
  const pairs: Array<{ basis: RateBasis; a: RateBandInput; b: RateBandInput; probe: { age: number; cover: string } }> = [
    { basis: "PER_MILLE", a: band({ id: "b1", sumAssured: "10000.00" }), b: band({ id: "b2", sumAssured: "20000.00" }), probe: { age: 30, cover: "10000.00" } },
    { basis: "FLAT", a: band({ id: "b1", minAge: 18, maxAge: 30 }), b: band({ id: "b2", minAge: 31, maxAge: 65 }), probe: { age: 40, cover: "10000.00" } },
    { basis: "AGE_BANDED", a: band({ id: "b1", minAge: 18, maxAge: 30 }), b: band({ id: "b2", minAge: 25, maxAge: 65 }), probe: { age: 27, cover: "10000.00" } },
  ]

  it.each(pairs)("colliding $basis bands quote AMBIGUOUS_BANDS", ({ basis, a, b, probe }) => {
    expect(bandsCollide(basis, a, b)).toBe(true)
    expect(rateLife([a, b], basis, "MAIN_MEMBER", probe.age, probe.cover)).toMatchObject({
      ok: false,
      reason: "AMBIGUOUS_BANDS",
      bandIds: ["b1", "b2"],
    })
  })

  it.each(ALL_BASES)("non-colliding %s bands price cleanly", (basis) => {
    // Disjoint on whichever axis this basis keys on.
    const axes = bandMatchAxes(basis)
    const a = band({ id: "b1", minAge: 18, maxAge: 30, sumAssured: "10000.00" })
    const b = axes.age
      ? band({ id: "b2", minAge: 31, maxAge: 65, sumAssured: "10000.00" })
      : band({ id: "b2", minAge: 18, maxAge: 30, sumAssured: "20000.00" })

    expect(bandsCollide(basis, a, b)).toBe(false)
    expect(rateLife([a, b], basis, "MAIN_MEMBER", 25, "10000.00")).toMatchObject({ ok: true, bandId: "b1" })
  })
})

describe("lifeTypesWithBands", () => {
  it("names each life type once, in the order the schema declares them", () => {
    const bands = [
      band({ id: "b1", lifeType: "SPOUSE" }),
      band({ id: "b2", lifeType: "MAIN_MEMBER" }),
      band({ id: "b3", lifeType: "SPOUSE" }),
    ]

    expect(lifeTypesWithBands(bands)).toEqual(["MAIN_MEMBER", "SPOUSE"])
  })

  it("is empty for an empty rate card", () => {
    expect(lifeTypesWithBands([])).toEqual([])
  })

  it.each(ALL_BASES)("a life type it omits cannot be priced under %s", (basis) => {
    const bands = [band({ id: "b1", lifeType: "MAIN_MEMBER" })]

    expect(lifeTypesWithBands(bands)).not.toContain("SPOUSE")
    expect(rateLife(bands, basis, "SPOUSE", 30, "10000.00")).toMatchObject({
      ok: false,
      reason: "NO_MATCHING_BAND",
    })
  })
})
