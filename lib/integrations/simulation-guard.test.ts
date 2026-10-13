import { describe, it, expect, vi, afterEach } from "vitest"
import { assertSimulationAllowed, isDeployedBuild, isSimulationPermitted } from "./simulation-guard"

afterEach(() => vi.unstubAllEnvs())

/**
 * These assert a compliance control, so each case states WHICH direction it
 * protects. The dangerous direction is a *permitted* simulation on a deployed
 * build — that is what fabricates a credit score or asserts a payout that never
 * happened. Every "allowed" case below therefore needs an explicit, deliberate
 * signal; everything else must throw.
 */
describe("assertSimulationAllowed", () => {
  it("is a no-op when dry-run was not requested (never throws on the real path)", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => assertSimulationAllowed("transunion", false)).not.toThrow()
  })

  it("allows simulation off a deployed build (local dev / unit tests)", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(() => assertSimulationAllowed("transunion", true)).not.toThrow()
    vi.stubEnv("NODE_ENV", "test")
    expect(() => assertSimulationAllowed("netcash", true)).not.toThrow()
  })

  // --- the dangerous direction -------------------------------------------
  it("THROWS on a deployed build with no declaration, for every guarded provider", () => {
    vi.stubEnv("NODE_ENV", "production")
    for (const provider of ["experian", "transunion", "netcash", "netcash-collections", "smileidentity"] as const) {
      expect(() => assertSimulationAllowed(provider, true), provider).toThrow()
    }
  })

  it("THROWS when the vendor sandbox variable holds an unexpected value (fails closed)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "PRODUCTION")
    expect(() => assertSimulationAllowed("experian", true)).toThrow()
    // Misspelling must not be read as a sandbox either.
    vi.stubEnv("EXPERIAN_ENV", "uat-1")
    expect(() => assertSimulationAllowed("experian", true)).toThrow()
  })

  it("THROWS when the allow-list names a DIFFERENT provider (per-provider blast radius)", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "netcash")
    expect(() => assertSimulationAllowed("transunion", true)).toThrow()
    expect(() => assertSimulationAllowed("netcash", true)).not.toThrow()
  })

  // --- the deliberate escape hatches --------------------------------------
  it("allows a vendor sandbox estate", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    expect(() => assertSimulationAllowed("experian", true)).not.toThrow()
  })

  it("allows an explicitly allow-listed provider, tolerating spacing and case", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", " TransUnion , netcash ")
    expect(() => assertSimulationAllowed("transunion", true)).not.toThrow()
    expect(() => assertSimulationAllowed("netcash", true)).not.toThrow()
  })

  it("preserves SmileIdentity's original message so its existing tests stay a real check", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_IDENTITY_ENV", "production")
    expect(() => assertSimulationAllowed("smileidentity", true)).toThrow(
      "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
    )
    vi.stubEnv("SMILE_IDENTITY_ENV", "test")
    expect(() => assertSimulationAllowed("smileidentity", true)).not.toThrow()
  })

  // --- regression: the refactor must not WIDEN an existing boundary ---------
  // The generic allow-list originally applied to every
  // provider, so `SIMULATED_INTEGRATIONS=smileidentity` bypassed Smile's
  // sandbox-only rule — which previously threw unconditionally whenever
  // SMILE_IDENTITY_ENV was not "test". A refactor billed as behaviour-preserving
  // had quietly loosened the KYC boundary. The original tests missed it because
  // they covered the allow-list and Smile SEPARATELY, never the interaction.
  it("does NOT let the generic allow-list satisfy a vendor-sandbox provider", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SMILE_IDENTITY_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "smileidentity,experian")
    expect(() => assertSimulationAllowed("smileidentity", true)).toThrow(
      "SMILE_DRY_RUN must not be enabled outside SMILE_IDENTITY_ENV=test",
    )
    // Experian carries a vendor signal too, so the list must not satisfy it either.
    vi.stubEnv("EXPERIAN_ENV", "PRODUCTION")
    expect(() => assertSimulationAllowed("experian", true)).toThrow()
  })

  it("the allow-list still works for providers with NO vendor signal", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "smileidentity,transunion")
    // smileidentity is ignored by the list; transunion is not.
    expect(() => assertSimulationAllowed("smileidentity", true)).toThrow()
    expect(() => assertSimulationAllowed("transunion", true)).not.toThrow()
  })

  it("names the remedy in the error, so an operator can act on it", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => assertSimulationAllowed("transunion", true)).toThrow(/SIMULATED_INTEGRATIONS/)
    expect(() => assertSimulationAllowed("experian", true)).toThrow(/EXPERIAN_ENV/)
  })

  it("treats staging as deployed — NODE_ENV is 'production' there too", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(isDeployedBuild()).toBe(true)
  })
})

describe("isSimulationPermitted", () => {
  it("is true off a deployed build", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(isSimulationPermitted("experian")).toBe(true)
  })

  it("is false on a deployed build with no declaration", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(isSimulationPermitted("experian")).toBe(false)
  })

  it("is true on a deployed build only for a declared sandbox", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    expect(isSimulationPermitted("experian")).toBe(true)
    vi.stubEnv("EXPERIAN_ENV", "PRODUCTION")
    expect(isSimulationPermitted("experian")).toBe(false)
  })
})
