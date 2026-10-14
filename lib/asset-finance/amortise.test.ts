import { describe, expect, it } from "vitest"
import { periodInterest } from "./amortise"

describe("periodInterest", () => {
  it("rounds an exact half cent up without binary floating-point drift", () => {
    // 118625 cents × 6% × 31 / 365 = exactly 604.5 cents.
    expect(periodInterest(118_625, 0.06 * 31)).toBe(605)
  })

  it("keeps the ordinary actual/365 examples", () => {
    expect(periodInterest(1_000_000, 0.12 * 31)).toBe(10_192)
    expect(periodInterest(670_262, 0.12 * 28)).toBe(6_170)
  })
})
