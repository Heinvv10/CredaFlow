import { afterEach, describe, expect, it } from "vitest"
import { activeCurrency, activeJurisdiction, isNcaJurisdiction, resetActiveJurisdiction, setActiveJurisdiction } from "./active"

afterEach(() => resetActiveJurisdiction())

describe("active jurisdiction", () => {
  it("is ZA / ZAR / NCA until something sets it, so an unconfigured process keeps today's behaviour", () => {
    expect(activeJurisdiction()).toBe("ZA")
    expect(activeCurrency()).toBe("ZAR")
    expect(isNcaJurisdiction()).toBe(true)
  })

  it("LS turns the NCA gate off and the loti on", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(activeJurisdiction()).toBe("LS")
    expect(activeCurrency()).toBe("LSL")
    expect(isNcaJurisdiction()).toBe(false)
  })

  it("an LS lender may still be billed in rand (the rand is legal tender in Lesotho)", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "ZAR" })
    expect(activeCurrency()).toBe("ZAR")
    expect(isNcaJurisdiction()).toBe(false)
  })

  it("is shared through globalThis, so separately bundled copies of the module agree", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const store = (globalThis as Record<symbol, unknown>)[Symbol.for("credaflow.activeJurisdiction")]
    expect(store).toMatchObject({ jurisdiction: "LS", currency: "LSL" })
  })

  it("refuses an unknown code rather than silently falling back", () => {
    expect(() => setActiveJurisdiction({ jurisdiction: "XX" as never, currency: "ZAR" })).toThrow(/jurisdiction/i)
    expect(() => setActiveJurisdiction({ jurisdiction: "ZA", currency: "USD" as never })).toThrow(/currency/i)
  })
})
