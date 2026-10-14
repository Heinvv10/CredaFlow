import { afterEach, describe, expect, it, vi } from "vitest"
import { SIMULATED_BUREAU_REASON, simulatedBureauBlock } from "./bureau-simulated"

afterEach(() => vi.unstubAllEnvs())

const check = (obligations: unknown, provider = "experian") => ({ obligations, provider })
const fromSimulator = check({ simulated: true, simulationSource: "simulated-bureau" }, "simulated")
const fromExperianDryRun = check({ simulated: true, simulationSource: "experian" })
const legacyDryRun = check({ simulated: true })

describe("simulatedBureauBlock — the policy of the provider that produced the check", () => {
  it("never blocks a genuine check", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(simulatedBureauBlock(check({ totalMonthly: 1 })).blocked).toBe(false)
    expect(simulatedBureauBlock(null).blocked).toBe(false)
  })

  it("permits simulated checks off a deployed build", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(simulatedBureauBlock(fromSimulator).blocked).toBe(false)
    expect(simulatedBureauBlock(legacyDryRun).blocked).toBe(false)
  })

  it("refuses the simulator's report on a deployed build, even one declared Experian UAT", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    expect(simulatedBureauBlock(fromSimulator)).toEqual({ blocked: true, reason: SIMULATED_BUREAU_REASON })
    // ...while the Experian dry-run keeps its existing UAT allowance.
    expect(simulatedBureauBlock(fromExperianDryRun).blocked).toBe(false)
    expect(simulatedBureauBlock(legacyDryRun).blocked).toBe(false)
  })

  it("permits the simulator's report on a deployed build only when it is named in SIMULATED_INTEGRATIONS", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-bureau")
    expect(simulatedBureauBlock(fromSimulator).blocked).toBe(false)
    // Naming the simulator does not open the Experian dry-run.
    expect(simulatedBureauBlock(legacyDryRun).blocked).toBe(true)
  })

  it("refuses a simulated check whose source it does not recognise, everywhere", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(simulatedBureauBlock(check({ simulated: true, simulationSource: "made-up" })).blocked).toBe(true)
    expect(simulatedBureauBlock(check({ simulated: true, simulationSource: 7 })).blocked).toBe(true)
  })

  it("governs a row from the simulated bureau by its provider, whatever its marker says", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    // Marker stripped, or relabelled as an Experian dry-run that UAT would allow.
    expect(simulatedBureauBlock(check({ totalMonthly: 0 }, "simulated")).blocked).toBe(true)
    expect(simulatedBureauBlock(check(null, "simulated")).blocked).toBe(true)
    expect(simulatedBureauBlock(check({ simulated: true, simulationSource: "experian" }, "simulated")).blocked).toBe(true)
  })
})
