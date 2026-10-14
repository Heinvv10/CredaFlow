import { afterEach, describe, expect, it, vi } from "vitest"
import { simulatedScreeningProvider } from "./simulated-provider"
import { getScreeningProvider } from "./registry"
import { SCREENING_TYPES, ScreeningProviderError } from "./types"

const subject = (lastName: string) => ({
  clientId: "client-sim", firstName: "Test", lastName, idNumber: "0000000000000", dateOfBirth: null,
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("simulated screening provider", () => {
  it("returns each fixture outcome on the fixture's type only", async () => {
    const cases = [
      ["Fixture-Pep", "PEP", "CONFIRMED_MATCH"],
      ["Fixture-Sanction", "SANCTIONS", "CONFIRMED_MATCH"],
      ["Fixture-Possible", "SANCTIONS", "POSSIBLE_MATCH"],
      ["Fixture-Media", "ADVERSE_MEDIA", "CONFIRMED_MATCH"],
    ] as const
    for (const [lastName, type, result] of cases) {
      const out = await simulatedScreeningProvider.screen(subject(lastName), SCREENING_TYPES)
      expect(out.simulated).toBe(true)
      for (const r of out.results) {
        expect(r.result, `${lastName} ${r.type}`).toBe(r.type === type ? result : "CLEAR")
        expect(r.matches.length).toBe(r.type === type ? 1 : 0)
      }
    }
  })

  it("screens any other surname clear", async () => {
    const out = await simulatedScreeningProvider.screen(subject("Example"), SCREENING_TYPES)
    expect(out.results.map((r) => r.result)).toEqual(["CLEAR", "CLEAR", "CLEAR"])
  })

  it("fails as a provider error for Fixture-Error", async () => {
    await expect(simulatedScreeningProvider.screen(subject("Fixture-Error"), SCREENING_TYPES))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR" })
  })

  it("is refused on a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const attempt = simulatedScreeningProvider.screen(subject("Example"), SCREENING_TYPES)
    await expect(attempt).rejects.toBeInstanceOf(ScreeningProviderError)
    await expect(simulatedScreeningProvider.screen(subject("Example"), SCREENING_TYPES))
      .rejects.toMatchObject({ code: "SIMULATION_FORBIDDEN" })
  })

  it("is allowed on a deployed build only when listed in SIMULATED_INTEGRATIONS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "transunion,screening")
    const out = await simulatedScreeningProvider.screen(subject("Example"), SCREENING_TYPES)
    expect(out.simulated).toBe(true)
  })
})

describe("screening registry", () => {
  it("refuses an unconfigured or unknown provider", () => {
    expect(() => getScreeningProvider(null)).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }))
    expect(() => getScreeningProvider("nope")).toThrow(expect.objectContaining({ code: "UNKNOWN_PROVIDER" }))
    expect(getScreeningProvider("simulated")).toBe(simulatedScreeningProvider)
  })
})
