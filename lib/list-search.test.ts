import { describe, expect, it } from "vitest"
import { matchesCentsAmount, matchesEveryWord, matchesRandAmount } from "./list-search"

describe("matchesCentsAmount", () => {
  const R50 = 5_000
  const R500 = 50_000
  const R1500 = 150_000
  const R1500_50 = 150_050
  const R5000 = 500_000

  // The defect this replaces: substring matching meant "50" hit every amount
  // containing those digits, so a staff member filtering for a R50 loan was
  // shown R500, R1,500 and R5,000 as well.
  it("does not match an amount merely containing the digits", () => {
    expect(matchesCentsAmount("50", R50)).toBe(true)
    expect(matchesCentsAmount("50", R500)).toBe(false)
    expect(matchesCentsAmount("50", R1500)).toBe(false)
    expect(matchesCentsAmount("50", R5000)).toBe(false)
  })

  // Staff read "R1,500.00" off the screen and type the rand figure. Requiring
  // ".00" would make the common case fail, so a whole-rand query matches every
  // cent value inside that rand.
  it("matches every cent value within a whole-rand query", () => {
    expect(matchesCentsAmount("1500", R1500)).toBe(true)
    expect(matchesCentsAmount("1500", R1500_50)).toBe(true)
    expect(matchesCentsAmount("1500", 150_099)).toBe(true)
    expect(matchesCentsAmount("1500", 149_999)).toBe(false)
    expect(matchesCentsAmount("1500", 15_000_00)).toBe(false)
  })

  it("matches the exact cent value when the query carries decimals", () => {
    expect(matchesCentsAmount("1500.50", R1500_50)).toBe(true)
    expect(matchesCentsAmount("1500.50", R1500)).toBe(false)
    expect(matchesCentsAmount("1500.5", R1500_50)).toBe(true)
  })

  // formatZAR renders "R 1,500.00", so a copy-paste carries the currency
  // symbol, spaces and thousands separators.
  it("ignores currency symbol, spaces and thousands separators", () => {
    expect(matchesCentsAmount("R 1,500.00", R1500)).toBe(true)
    expect(matchesCentsAmount("R1500", R1500)).toBe(true)
    expect(matchesCentsAmount(" 1 500 ", R1500)).toBe(true)
  })

  it("is not an amount query when it holds no digits", () => {
    expect(matchesCentsAmount("", R1500)).toBe(false)
    expect(matchesCentsAmount("mabaso", R1500)).toBe(false)
    expect(matchesCentsAmount("R", R1500)).toBe(false)
    expect(matchesCentsAmount(".", R1500)).toBe(false)
  })

  it("rejects a malformed query rather than guessing", () => {
    expect(matchesCentsAmount("15.00.50", R1500)).toBe(false)
  })

  it("handles zero", () => {
    expect(matchesCentsAmount("0", 0)).toBe(true)
    expect(matchesCentsAmount("0", 50)).toBe(true) // R0.50 is within rand 0
    expect(matchesCentsAmount("0.50", 50)).toBe(true)
    expect(matchesCentsAmount("0", R50)).toBe(false)
  })
})

// Insurance stores premiumAmount / sumAssured as Decimal(12,2) RANDS, not
// cents. Passing a rand figure to the cents matcher would be wrong by 100x.
describe("matchesRandAmount", () => {
  it("applies the same rules to a rand-denominated amount", () => {
    expect(matchesRandAmount("50", 50)).toBe(true)
    expect(matchesRandAmount("50", 500)).toBe(false)
    expect(matchesRandAmount("1500", 1500.5)).toBe(true)
    expect(matchesRandAmount("1500.50", 1500.5)).toBe(true)
    expect(matchesRandAmount("1500.50", 1500)).toBe(false)
    expect(matchesRandAmount("mabaso", 1500)).toBe(false)
  })

  // Decimal columns arrive as strings or Prisma Decimals through Number().
  it("tolerates float representation error", () => {
    expect(matchesRandAmount("1500.10", 1500.1)).toBe(true)
    expect(matchesRandAmount("0.30", 0.1 + 0.2)).toBe(true)
  })
})

// Pinned, not endorsed: the parser strips a minus with the rest of the
// punctuation. No field wired to this module is signed today. If one ever is
// (BankTransaction.amountCents), these break and force the sign to be handled
// rather than letting a search silently find nothing.
describe("matchesCentsAmount is unsigned", () => {
  it("cannot find a negative amount", () => {
    expect(matchesCentsAmount("-50", -5_000)).toBe(false)
    expect(matchesCentsAmount("50", -5_000)).toBe(false)
  })

  it("treats a negative query as its positive counterpart", () => {
    expect(matchesCentsAmount("-50", 5_000)).toBe(true)
  })
})

// The payments screen does not use formatZAR. It has its own
// `toLocaleString("en-ZA")` formatter, which is true SA convention: a SPACE
// for thousands and a COMMA for the decimal. So the same R1,500.50 renders
// "R 1,500.50" on five screens and "1 500,50" on payments. Pasting what the
// payments screen shows returned nothing at all until the parser learned both.
describe("matchesCentsAmount accepts both money formats the app renders", () => {
  const R500 = 50_000
  const R1500_50 = 150_050
  const R10000 = 1_000_000

  it("reads a comma as the decimal separator when it ends the amount", () => {
    expect(matchesCentsAmount("500,00", R500)).toBe(true)
    expect(matchesCentsAmount("R 500,00", R500)).toBe(true)
    expect(matchesCentsAmount("1 500,50", R1500_50)).toBe(true)
  })

  it("still reads a comma as a thousands separator before three digits", () => {
    expect(matchesCentsAmount("1,500", 150_000)).toBe(true)
    expect(matchesCentsAmount("1,500", R1500_50)).toBe(true)
    expect(matchesCentsAmount("10,000", R10000)).toBe(true)
    expect(matchesCentsAmount("10 000,00", R10000)).toBe(true)
  })

  it("keeps reading the formatZAR convention the other five screens render", () => {
    expect(matchesCentsAmount("R 1,500.50", R1500_50)).toBe(true)
    expect(matchesCentsAmount("R 10,000.00", R10000)).toBe(true)
  })

  // Groups after the first must be exactly three digits, so a malformed
  // amount is still refused rather than read as a number it does not name.
  it("refuses an integer part whose grouping is not real grouping", () => {
    expect(matchesCentsAmount("15.00.50", 150_050)).toBe(false)
    expect(matchesCentsAmount("1,50,000", R10000)).toBe(false)
  })

  // The two above also return false under the old parser, for unrelated
  // reasons, so they cannot tell the grouping check is what fires. This one
  // can: stripping the comma reads "1,5000" as R15,000, which is a number the
  // query does not name.
  it("refuses rather than reading a bad group as a larger amount", () => {
    expect(matchesCentsAmount("1,5000", 1_500_000)).toBe(false)
  })
})

// Fair Score audit (2026-10-16): the claim client search found nothing for
// "Lerato Mah" (first name plus the start of the surname) and only worked on
// the email address. Every word must match some field, in any order.
describe("matchesEveryWord", () => {
  const lerato = ["Lerato", "Mahlangu", "lerato.m@client.invalid"]

  it("matches a first name with the start of the surname", () => {
    expect(matchesEveryWord("Lerato Mah", lerato)).toBe(true)
    expect(matchesEveryWord("  lerato   MAH ", lerato)).toBe(true)
  })

  it("matches the words in either order, and a single word as before", () => {
    expect(matchesEveryWord("Mahlangu Lerato", lerato)).toBe(true)
    expect(matchesEveryWord("mahl", lerato)).toBe(true)
    expect(matchesEveryWord("lerato.m@client", lerato)).toBe(true)
  })

  it("refuses when any word matches nothing", () => {
    expect(matchesEveryWord("Lerato Dlamini", lerato)).toBe(false)
  })

  it("matches everything for an empty query", () => {
    expect(matchesEveryWord("   ", lerato)).toBe(true)
  })
})
