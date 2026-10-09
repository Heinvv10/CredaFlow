import { describe, expect, it } from "vitest"
import { addCents, formatCents, mulDivCents, toCents } from "./rand-cents"

describe("toCents", () => {
  it("parses a fixed 2dp rand string exactly", () => {
    expect(toCents("123.45")).toBe(12345)
    expect(toCents("0.01")).toBe(1)
    expect(toCents("10000.00")).toBe(1000000)
  })

  it("parses a Prisma Decimal via toFixed, not via valueOf", () => {
    // Prisma returns Decimal for @db.Decimal columns. Its toFixed(2) is exact
    // for a Decimal(12,2) column; Number(decimal) is not.
    const decimalLike = { toFixed: (dp: number) => (dp === 2 ? "1234.56" : "1234.5600") }
    expect(toCents(decimalLike)).toBe(123456)
  })

  it("parses whole and single-decimal strings", () => {
    expect(toCents("7")).toBe(700)
    expect(toCents("7.5")).toBe(750)
  })

  it("parses a number only when it round-trips at 2dp", () => {
    expect(toCents(150)).toBe(15000)
    expect(toCents(150.5)).toBe(15050)
    expect(toCents(150.55)).toBe(15055)
  })

  it("refuses a number carrying more than 2 decimal places rather than rounding it", () => {
    // Silently rounding a third decimal is how a float creeps into a money
    // path. The caller must decide, not this function.
    expect(() => toCents(150.555)).toThrow(/2 decimal places/)
  })

  it("refuses non-finite and unparseable input", () => {
    expect(() => toCents(Number.NaN)).toThrow()
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => toCents("R150")).toThrow()
    expect(() => toCents("1,50")).toThrow()
    expect(() => toCents("")).toThrow()
  })

  it("does not lose the classic binary-float cases", () => {
    // 0.1 + 0.2 in JS floats is 0.30000000000000004. Via cents it is exact.
    expect(addCents(toCents("0.10"), toCents("0.20"))).toBe(30)
    // 1.005 has no exact float representation, so `(1.005 * 100).toFixed(0)`
    // yields 100, not 101. A third decimal is refused outright instead.
    expect(() => toCents("1.005")).toThrow(/2 decimal places/)
  })
})

describe("formatCents", () => {
  it("renders a canonical 2dp rand string safe to hand to Prisma Decimal", () => {
    expect(formatCents(12345)).toBe("123.45")
    expect(formatCents(1)).toBe("0.01")
    expect(formatCents(0)).toBe("0.00")
    expect(formatCents(1000000)).toBe("10000.00")
  })

  it("round-trips through toCents", () => {
    for (const cents of [0, 1, 99, 100, 12345, 999999999]) {
      expect(toCents(formatCents(cents))).toBe(cents)
    }
  })
})

describe("mulDivCents", () => {
  it("computes per-mille cover exactly: R5.50 per R1000 on R25 000 cover", () => {
    // 5.50 * 25000 / 1000 = 137.50
    expect(mulDivCents(toCents("5.50"), toCents("25000.00"), 100_000)).toBe(13750)
  })

  it("rounds half-up on the final cent rather than truncating", () => {
    // 3.33 per R1000 on R1 500 cover = 4.995 -> 5.00
    expect(mulDivCents(toCents("3.33"), toCents("1500.00"), 100_000)).toBe(500)
    // 3.33 per R1000 on R500 cover = 1.665 -> 1.67
    expect(mulDivCents(toCents("3.33"), toCents("500.00"), 100_000)).toBe(167)
  })

  it("stays exact at amounts where float multiplication drifts", () => {
    // 0.07 * 1_000_000.00 / 1000 in floats yields 70.00000000000001.
    expect(mulDivCents(toCents("0.07"), toCents("1000000.00"), 100_000)).toBe(7000)
  })
})
