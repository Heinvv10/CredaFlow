import { describe, expect, it } from "vitest"
import { msToNextTotpStep } from "./clock"

describe("msToNextTotpStep", () => {
  it("is the time to the next 30 s boundary plus a margin, always inside the next step", () => {
    expect(msToNextTotpStep(0)).toBe(30_500)
    expect(msToNextTotpStep(29_999)).toBe(501)
    expect(msToNextTotpStep(45_000)).toBe(15_500)
    for (const now of [1, 12_345, 29_500, 1_760_000_000_000]) {
      const landed = now + msToNextTotpStep(now)
      expect(Math.floor(landed / 30_000)).toBe(Math.floor(now / 30_000) + 1)
    }
  })
})
