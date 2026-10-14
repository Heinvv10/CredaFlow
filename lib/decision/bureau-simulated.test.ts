import { afterEach, describe, expect, it, vi } from "vitest"
import { SIMULATED_BUREAU_REASON, simulatedBureauBlock } from "./bureau-simulated"

afterEach(() => vi.unstubAllEnvs())

const fromSimulator = { simulated: true, simulationSource: "simulated-bureau" }
const fromExperianDryRun = { simulated: true, simulationSource: "experian" }
const legacyDryRun = { simulated: true }

describe("simulatedBureauBlock — the policy of the provider that produced the check", () => {
  it("never blocks a genuine check", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(simulatedBureauBlock({ totalMonthly: 1 }).blocked).toBe(false)
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
    expect(simulatedBureauBlock({ simulated: true, simulationSource: "made-up" }).blocked).toBe(true)
    expect(simulatedBureauBlock({ simulated: true, simulationSource: 7 }).blocked).toBe(true)
  })
})
