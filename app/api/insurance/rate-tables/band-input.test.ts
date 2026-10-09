// app/api/insurance/rate-tables/band-input.test.ts
//
// A band is one row of the insurer's rate card, and its money columns are
// `Decimal(12, 2)`. Postgres ROUNDS a value with more decimals than the column
// holds rather than refusing it, so a premium of R0.001 is accepted by the
// route and stored as R0.00 — a free policy nobody priced, arrived at by
// silent truncation. The validator, not the column, has to be the thing that
// says no.
//
// The same column has a ceiling: 9 999 999 999.99. Past it Postgres raises
// `numeric field overflow`, and an age past 2^31-1 raises `integer out of
// range`. Neither is an error the API can render usefully, so both are refused
// before the statement is built.
import { describe, expect, it } from "vitest"
import { parseBandInput, overlapWhere, type BandInput } from "./band-input"
import { bandsCollide } from "@/lib/insurance/rating/band-match"

const VALID = {
  lifeType: "MAIN_MEMBER",
  minAge: 18,
  maxAge: 64,
  sumAssured: 30000,
  premiumAmount: 84.5,
}

function parse(overrides: Record<string, unknown> = {}, base?: BandInput) {
  return parseBandInput({ ...VALID, ...overrides }, base)
}

describe("parseBandInput — sub-cent money", () => {
  it.each([
    ["premiumAmount", 0.001],
    ["premiumAmount", 0.004],
    ["sumAssured", 0.004],
  ])("refuses a %s of %s that Decimal(12,2) would round to zero", (field, value) => {
    const result = parse({ [field]: value })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(field)
  })

  it.each([
    ["premiumAmount", 84.555],
    ["sumAssured", 30000.555],
  ])("refuses a %s carrying more than 2 decimal places", (field, value) => {
    const result = parse({ [field]: value })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(field)
  })

  it("accepts a value sitting exactly on a whole cent", () => {
    const result = parse({ premiumAmount: 84.51, sumAssured: 30000 })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.premiumAmount).toBe(84.51)
  })

  it("accepts the smallest storable premium, one cent", () => {
    expect(parse({ premiumAmount: 0.01 }).ok).toBe(true)
  })
})

describe("parseBandInput — upper bounds", () => {
  it.each([
    ["minAge past a human lifetime", { minAge: 121, maxAge: 200 }],
    ["maxAge past a human lifetime", { maxAge: 121 }],
    ["maxAge past the int32 ceiling", { maxAge: 2147483648 }],
  ])("refuses %s", (_label, override) => {
    expect(parse(override).ok).toBe(false)
  })

  it("accepts the boundary age of 120", () => {
    expect(parse({ minAge: 0, maxAge: 120 }).ok).toBe(true)
  })

  it.each([
    ["premiumAmount", 1e30],
    ["sumAssured", 1e30],
    ["premiumAmount", 10000000000],
    ["sumAssured", 10000000000],
  ])("refuses a %s of %s that overflows Decimal(12,2)", (field, value) => {
    const result = parse({ [field]: value })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(field)
  })

  it("accepts the largest value Decimal(12,2) can hold", () => {
    expect(parse({ sumAssured: 9999999999.99 }).ok).toBe(true)
  })
})

describe("overlapWhere", () => {
  const band: BandInput = {
    lifeType: "MAIN_MEMBER" as BandInput["lifeType"],
    minAge: 18,
    maxAge: 64,
    sumAssured: 30000.5,
    premiumAmount: 84.5,
  }

  it("compares sumAssured at the stored 2dp scale", () => {
    // A raw JS number would be compared against a column Postgres has already
    // rounded, so the check has to normalise to the same scale or it misses.
    expect(overlapWhere("table-1", "AGE_BANDED", band).sumAssured).toBe(30000.5)
  })

  it("keys AGE_BANDED on the life type, the cover tier AND the age range", () => {
    expect(overlapWhere("table-1", "AGE_BANDED", band)).toEqual({
      rateTableId: "table-1",
      lifeType: "MAIN_MEMBER",
      sumAssured: 30000.5,
      minAge: { lte: 64 },
      maxAge: { gte: 18 },
    })
  })

  it("drops the age range for FLAT, where age is not a rating factor", () => {
    // Two FLAT bands at the same cover collide whatever their age ranges say,
    // because rateLife never looks at them.
    expect(overlapWhere("table-1", "FLAT", band)).toEqual({
      rateTableId: "table-1",
      lifeType: "MAIN_MEMBER",
      sumAssured: 30000.5,
    })
  })

  it("drops sumAssured for PER_MILLE — the defect that let ambiguous bands in", () => {
    // rateLife ignores a PER_MILLE band's own sumAssured, so keying the
    // collision on it stored two MAIN_MEMBER 18-65 bands at different cover
    // amounts and made every life on the table unquotable.
    expect(overlapWhere("table-1", "PER_MILLE", band)).toEqual({
      rateTableId: "table-1",
      lifeType: "MAIN_MEMBER",
      minAge: { lte: 64 },
      maxAge: { gte: 18 },
    })
  })

  it.each(["AGE_BANDED", "FLAT", "PER_MILLE"] as const)(
    "excludes the band being edited under %s, so a PATCH never collides with itself",
    (basis) => {
      expect(overlapWhere("table-1", basis, band, "band-1").NOT).toEqual({ id: "band-1" })
    },
  )
})

describe("overlapWhere agrees with bandsCollide", () => {
  // The write path issues a Prisma query; the rating path runs in memory. They
  // must refuse the same pairs, so the WHERE clause is applied here as a
  // predicate and compared against bandsCollide band for band.
  const existing: BandInput[] = [
    { lifeType: "MAIN_MEMBER" as BandInput["lifeType"], minAge: 18, maxAge: 30, sumAssured: 10000, premiumAmount: 50 },
    { lifeType: "MAIN_MEMBER" as BandInput["lifeType"], minAge: 31, maxAge: 65, sumAssured: 10000, premiumAmount: 60 },
    { lifeType: "MAIN_MEMBER" as BandInput["lifeType"], minAge: 18, maxAge: 30, sumAssured: 20000, premiumAmount: 90 },
    { lifeType: "SPOUSE" as BandInput["lifeType"], minAge: 18, maxAge: 30, sumAssured: 10000, premiumAmount: 40 },
  ]
  const candidate: BandInput = {
    lifeType: "MAIN_MEMBER" as BandInput["lifeType"],
    minAge: 25,
    maxAge: 40,
    sumAssured: 10000,
    premiumAmount: 55,
  }

  /** Evaluate the generated WHERE clause against an in-memory row. */
  function matchesWhere(where: ReturnType<typeof overlapWhere>, row: BandInput): boolean {
    if (where.lifeType !== row.lifeType) return false
    if (where.sumAssured !== undefined && where.sumAssured !== row.sumAssured) return false
    if (where.minAge !== undefined && !(row.minAge <= where.minAge.lte)) return false
    if (where.maxAge !== undefined && !(row.maxAge >= where.maxAge.gte)) return false
    return true
  }

  it.each(["AGE_BANDED", "FLAT", "PER_MILLE"] as const)("refuses exactly the colliding rows under %s", (basis) => {
    const where = overlapWhere("table-1", basis, candidate)

    for (const row of existing) {
      expect(matchesWhere(where, row), `${basis} ${row.lifeType} ${row.minAge}-${row.maxAge} @ ${row.sumAssured}`).toBe(
        bandsCollide(basis, candidate, row),
      )
    }
  })
})
