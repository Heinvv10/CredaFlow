import { describe, it, expect } from "vitest"
import { centsToRandExpenses, centsToRandDebts, randsToCents } from "./client-edit-money"

describe("randsToCents", () => {
  // The client edit form used parseInt(value) * 100, which discards cents
  // outright: a client earning R7 230,99 was stored as R7 230,00 on every save.
  // That is not cosmetic — income is fingerprinted into the immutable approval
  // snapshot, so a routine save silently invalidated an approved application.
  it.each([
    ["7230.99", 723099],
    ["7304.03", 730403],
    ["7230", 723000],
    ["0.01", 1],
    ["0.99", 99],
  ])("keeps the cents in %s", (input, expected) => {
    expect(randsToCents(input)).toBe(expected)
  })

  // Number("1500.99") * 100 is 150098.99999999999 in IEEE-754. Prisma rejects a
  // non-integer for an Int column, so an unrounded conversion fails the save
  // outright rather than storing a wrong number.
  it.each([
    [1500.99, 150099],
    [150.01, 15001],
    [1.15, 115],
    [8.29, 829],
  ])("rounds %s to an exact integer", (input, expected) => {
    const result = randsToCents(input)
    expect(result).toBe(expected)
    expect(Number.isInteger(result)).toBe(true)
  })

  it("treats blank and unparseable input as zero", () => {
    expect(randsToCents("")).toBe(0)
    expect(randsToCents(null)).toBe(0)
    expect(randsToCents(undefined)).toBe(0)
    expect(randsToCents("not a number")).toBe(0)
  })

  it("round-trips a cent-precise stored amount through the rand form", () => {
    const stored = { housing: 150099, transport: 0, food: 0, education: 0,
      insurance: 0, clothing: 0, entertainment: 0, medical: 0, other: 0 }
    const seeded = centsToRandExpenses(stored)
    expect(seeded.housing).toBe(1500.99)
    expect(randsToCents(seeded.housing)).toBe(150099)
  })
})

describe("centsToRandExpenses", () => {
  it("converts every category from cents to rands", () => {
    const out = centsToRandExpenses({
      housing: 80000, transport: 120000, food: 60000, education: 0,
      insurance: 50000, clothing: 0, entertainment: 0, medical: 0, other: 0,
    })
    // Independent expected values (NOT derived from the input) so removing the
    // `/100` makes this fail.
    expect(out).toEqual({
      housing: 800, transport: 1200, food: 600, education: 0,
      insurance: 500, clothing: 0, entertainment: 0, medical: 0, other: 0,
    })
  })

  it("keeps only editable fields while preserving the audited MLE justification", () => {
    // Raw Prisma rows carry ids and timestamps that must not leak into editable
    // state, while the regulatory justification must survive a no-op save.
    const rawRow = {
      id: "clxtest000000000000000003",
      clientId: "clxtest000000000000000004",
      housing: 80000, transport: 120000, food: 60000, education: 0,
      insurance: 50000, clothing: 0, entertainment: 0, medical: 0, other: 0,
      belowMleJustification: "client lives with family",
      updatedAt: new Date("2026-07-21T16:16:29+02:00"),
    } as unknown as Parameters<typeof centsToRandExpenses>[0]

    const out = centsToRandExpenses(rawRow)

    expect(Object.keys(out).sort()).toEqual([
      "belowMleJustification",
      "clothing", "education", "entertainment", "food", "housing",
      "insurance", "medical", "other", "transport",
    ])
    // Summing the known amount fields must stay numeric.
    const total = [
      out.housing, out.transport, out.food, out.education, out.insurance,
      out.clothing, out.entertainment, out.medical, out.other,
    ].reduce((sum, value) => sum + value, 0)
    expect(typeof total).toBe("number")
    expect(total).toBe(800 + 1200 + 600 + 500)
    expect(out.belowMleJustification).toBe("client lives with family")
  })

  it("round-trips against handleSubmit's conversion — no double-conversion", () => {
    const stored = {
      housing: 80000, transport: 120000, food: 60000, education: 0,
      insurance: 50000, clothing: 0, entertainment: 0, medical: 0, other: 0,
    }
    const seeded = centsToRandExpenses(stored)
    // Uses the production helper, not a local *100: a test that reimplements
    // the conversion cannot fail when the real one changes.
    const resubmitted = Object.fromEntries(
      Object.entries(seeded).map(([k, v]) => [k, randsToCents(v)]),
    )
    expect(resubmitted).toEqual(stored) // identical — no ×100 inflation on re-save
  })

  it("returns all zeros when there is no breakdown row", () => {
    expect(centsToRandExpenses(null)).toEqual({
      housing: 0, transport: 0, food: 0, education: 0,
      insurance: 0, clothing: 0, entertainment: 0, medical: 0, other: 0,
    })
    expect(centsToRandExpenses(undefined)).toEqual(centsToRandExpenses(null))
  })
})

describe("centsToRandDebts", () => {
  it("converts the two money fields to rands and preserves notes", () => {
    const out = centsToRandDebts([
      {
        creditProvider: "ABSA", accountType: "personal_loan",
        outstandingBalance: 0, monthlyInstalment: 49100, notes: "keep me",
      } as unknown as { outstandingBalance: number; monthlyInstalment: number },
    ])
    expect(out[0].outstandingBalance).toBe(0)
    // 49100 cents -> R491: the exact inverse of the prod-corruption case.
    expect(out[0].monthlyInstalment).toBe(491)
    expect((out[0] as { notes?: string }).notes).toBe("keep me")
  })

  it("round-trips against the production conversion — no double-conversion", () => {
    const stored = [{ outstandingBalance: 250000, monthlyInstalment: 49400 }]
    const seeded = centsToRandDebts(stored)
    const resubmitted = seeded.map((d) => ({
      ...d,
      outstandingBalance: randsToCents(d.outstandingBalance),
      monthlyInstalment: randsToCents(d.monthlyInstalment),
    }))
    expect(resubmitted).toEqual(stored)
  })

  it("returns [] for null / undefined / empty", () => {
    expect(centsToRandDebts(null)).toEqual([])
    expect(centsToRandDebts(undefined)).toEqual([])
    expect(centsToRandDebts([])).toEqual([])
  })
})
