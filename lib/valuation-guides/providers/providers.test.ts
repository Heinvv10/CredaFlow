import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getValuationProvider, registeredValuationProviderIds } from "../registry"
import { ValuationProviderError } from "../types"
import { csvGuideProvider } from "./csv-guide"
import { SYNTHETIC_GUIDE_ROWS } from "../__fixtures__/synthetic-valuation-guide"
import { syntheticValuationProvider } from "./synthetic"

const csv = (text: string) => new TextEncoder().encode(text)

describe("valuation providers", () => {
  beforeEach(() => vi.unstubAllEnvs())
  afterEach(() => vi.unstubAllEnvs())

  it("registers the CSV guide and the synthetic provider, and nothing else", () => {
    expect(registeredValuationProviderIds().sort()).toEqual(["csv", "synthetic"])
    expect(getValuationProvider("csv")).toBe(csvGuideProvider)
    expect(getValuationProvider("synthetic")).toBe(syntheticValuationProvider)
    expect(getValuationProvider("auto-guide-api")).toBeNull()
    expect(csvGuideProvider.simulated).toBe(false)
    expect(syntheticValuationProvider.simulated).toBe(true)
  })

  it("reads a CSV guide from its bytes, hashing exactly those bytes", async () => {
    const bytes = csv("make,model,year,variant,trade_cents,retail_cents\nTEST,EX-1,2025,,1,2\n")
    const result = await csvGuideProvider.readGuide({ bytes, effectiveOn: "2026-01-01" })
    expect(result).toEqual({
      ok: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rows: [{ lineNumber: 2, make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 1, retailCents: 2 }],
    })
    const again = await csvGuideProvider.readGuide({ bytes: csv("make,model,year,variant,trade_cents,retail_cents\nTEST,EX-1,2025,,1,2\n"), effectiveOn: "2027-01-01" })
    expect(again.ok && result.ok && again.sha256).toBe(result.ok && result.sha256)
    expect(await csvGuideProvider.readGuide({ effectiveOn: "2026-01-01" })).toEqual({ ok: false, total: 1, problems: [{ line: 1, reason: "Choose the CSV file to upload" }] })
  })

  it("refuses the synthetic guide on a deployed build that does not name it in SIMULATED_INTEGRATIONS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    expect(() => syntheticValuationProvider.assertUsable()).toThrow(ValuationProviderError)
    await expect(syntheticValuationProvider.readGuide({ effectiveOn: "2026-01-01" })).rejects.toMatchObject({ name: "ValuationProviderError", code: "NOT_CONFIGURED" })
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-telematics")
    expect(() => syntheticValuationProvider.assertUsable()).toThrow(/not permitted on a deployed build/)
  })

  it("loads it on a deployed build that names simulated-valuation-guide, and outside a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections, simulated-valuation-guide")
    expect(() => syntheticValuationProvider.assertUsable()).not.toThrow()
    vi.stubEnv("NODE_ENV", "test")
    const result = await syntheticValuationProvider.readGuide({ effectiveOn: "2026-01-01" })
    expect(result.ok && result.rows).toEqual(SYNTHETIC_GUIDE_ROWS.map((row, i) => ({ lineNumber: i + 2, ...row })))
    const other = await syntheticValuationProvider.readGuide({ effectiveOn: "2026-02-01" })
    expect(result.ok && other.ok && result.sha256 !== other.sha256).toBe(true)
  })
})
