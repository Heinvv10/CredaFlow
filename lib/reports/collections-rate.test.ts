import { describe, it, expect, vi, afterEach } from "vitest"
import { computeCollectionsRate, computeArrearsRate } from "./collections-rate"

describe("computeCollectionsRate", () => {
  it("100 loans (collectible book), 0 in arrears -> 100%", () => {
    expect(computeCollectionsRate(100, 0)).toBe(100)
  })
  it("100 loans (collectible book), 20 in arrears -> 80%", () => {
    expect(computeCollectionsRate(100, 20)).toBe(80)
  })
  it("no loans -> defined as 100% (nothing to collect)", () => {
    expect(computeCollectionsRate(0, 0)).toBe(100)
  })

  describe("population mismatch guard", () => {
    afterEach(() => vi.restoreAllMocks())

    it("logs and returns null instead of a negative rate when arrearsLoanCount exceeds totalLoanCount", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      // This is the board-pack bug that produced "-175%": an ACTIVE-only
      // denominator (40) against an ACTIVE+DEFAULTED-in-arrears numerator
      // (110). Now that app/(dashboard)/reports/board-pack/page.tsx sources
      // both counts from the same collectible-book (ACTIVE+DEFAULTED)
      // population, this input is structurally unreachable from that call
      // site — the guard exists as defense-in-depth against a future caller
      // re-mixing populations, not because the page can still trigger it.
      expect(computeCollectionsRate(40, 110)).toBeNull()
      expect(errorSpy).toHaveBeenCalledOnce()
    })
  })
})

describe("computeArrearsRate", () => {
  it("50 of 100 book value in arrears -> 50.0%", () => {
    expect(computeArrearsRate(50, 100)).toBe("50.0")
  })
  it("no arrears -> 0.0%", () => {
    expect(computeArrearsRate(0, 100)).toBe("0.0")
  })
  it("zero book with zero arrears -> defined as 0.0%", () => {
    expect(computeArrearsRate(0, 0)).toBe("0.0")
  })
  it("zero book with nonzero arrears -> defined as 0.0% (unreachable-defensive: no collectible book means no loan can carry arrears; the book<=0 branch wins before the mismatch guard below is ever reached)", () => {
    expect(computeArrearsRate(50, 0)).toBe("0.0")
  })

  describe("population mismatch guard", () => {
    afterEach(() => vi.restoreAllMocks())

    it("logs and returns null instead of a rate above 100% when totalArrears exceeds book", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      expect(computeArrearsRate(150, 100)).toBeNull()
      expect(errorSpy).toHaveBeenCalledOnce()
    })
  })
})
