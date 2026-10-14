import { afterEach, describe, expect, it, vi } from "vitest"
import { simulatedScreeningProvider } from "./simulated-provider"
import { expectedTypesFor, getScreeningProvider, registerScreeningProvider } from "./registry"
import { callProvider } from "./provider-call"
import { SCREENING_TYPES, ScreeningProviderError, type ScreeningSubject } from "./types"

const person = (lastName: string): ScreeningSubject => ({
  kind: "PERSON", clientId: "client-sim", firstName: "Test", lastName, idNumber: "0000000000000", dateOfBirth: null,
})
const entity = (legalName: string): ScreeningSubject => ({
  kind: "ENTITY", entityId: "entity-sim", entityType: "COMPANY", legalName, registrationNumber: "0000/000000/00",
})
const opts = () => ({ signal: new AbortController().signal })

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
      const out = await simulatedScreeningProvider.screen(person(lastName), SCREENING_TYPES, opts())
      expect(out.simulated).toBe(true)
      for (const r of out.results) {
        expect(r.result, `${lastName} ${r.type}`).toBe(r.type === type ? result : "CLEAR")
        expect(r.matches.length).toBe(r.type === type ? 1 : 0)
      }
    }
  })

  it("screens an entity by its legal name", async () => {
    const out = await simulatedScreeningProvider.screen(entity("Fixture-Sanction"), SCREENING_TYPES, opts())
    expect(out.results.find((r) => r.type === "SANCTIONS")?.result).toBe("CONFIRMED_MATCH")
    const clear = await simulatedScreeningProvider.screen(entity("Example Holdings"), SCREENING_TYPES, opts())
    expect(clear.results.map((r) => r.result)).toEqual(["CLEAR", "CLEAR", "CLEAR"])
  })

  it("screens any other surname clear", async () => {
    const out = await simulatedScreeningProvider.screen(person("Example"), SCREENING_TYPES, opts())
    expect(out.results.map((r) => r.result)).toEqual(["CLEAR", "CLEAR", "CLEAR"])
  })

  it("fails as a provider error for Fixture-Error", async () => {
    await expect(simulatedScreeningProvider.screen(person("Fixture-Error"), SCREENING_TYPES, opts()))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR" })
  })

  it("is refused on a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(simulatedScreeningProvider.screen(person("Example"), SCREENING_TYPES, opts())).rejects.toBeInstanceOf(ScreeningProviderError)
    await expect(simulatedScreeningProvider.screen(person("Example"), SCREENING_TYPES, opts())).rejects.toMatchObject({ code: "SIMULATION_FORBIDDEN" })
  })

  it("is allowed on a deployed build only when listed in SIMULATED_INTEGRATIONS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "transunion,screening")
    expect((await simulatedScreeningProvider.screen(person("Example"), SCREENING_TYPES, opts())).simulated).toBe(true)
  })
})

describe("screening registry", () => {
  it("refuses an unconfigured or unknown provider", () => {
    expect(() => getScreeningProvider(null)).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }))
    expect(() => getScreeningProvider("nope")).toThrow(expect.objectContaining({ code: "UNKNOWN_PROVIDER" }))
    expect(getScreeningProvider("simulated")).toBe(simulatedScreeningProvider)
  })

  it("A2: reports each provider's supported types, all types for an unknown one", () => {
    registerScreeningProvider({ id: "two-type-test", label: "t", simulated: false, supportedTypes: ["PEP", "SANCTIONS"], screen: async () => ({ results: [], providerReference: null }) })
    expect(expectedTypesFor("two-type-test")).toEqual(["PEP", "SANCTIONS"])
    expect(expectedTypesFor("nope")).toEqual(SCREENING_TYPES)
  })
})

describe("A4: provider timeout", () => {
  it("aborts a provider that does not answer in time and reports TIMEOUT, even if it ignores the signal", async () => {
    let sawAbort = false
    registerScreeningProvider({
      id: "hanging-test", label: "t", simulated: false, supportedTypes: SCREENING_TYPES,
      screen: (_s, _t, { signal }) => {
        signal.addEventListener("abort", () => { sawAbort = true })
        return new Promise(() => undefined)
      },
    })
    const { outcome } = await callProvider("hanging-test", person("Example"), 30)
    expect(outcome).toMatchObject({ ok: false, code: "TIMEOUT" })
    expect(sawAbort).toBe(true)
  })

  it("reports a provider exception as an outcome, not a throw", async () => {
    const { outcome } = await callProvider("nope", person("Example"), 30)
    expect(outcome).toMatchObject({ ok: false, code: "UNKNOWN_PROVIDER" })
  })
})
