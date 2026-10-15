import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseEnquiryResult, type ExperianResult } from "@/lib/integrations/experian"
import { bureauInstalmentTotalCents } from "../normalise"
import { reportObligations } from "../persist"
import { bureauObligationsKnown } from "@/lib/affordability/snapshot"
import { BureauProviderError, type BureauEnquiryRequest } from "../types"
import { experianBureau, experianReport } from "./experian"
import { simulatedBureau, simulatedScenarioFor } from "./simulated"
import { SKELETON_BUREAUS } from "./skeletons"
import { SIMULATED_SCENARIOS } from "../__fixtures__/simulated-reports"

afterEach(() => vi.unstubAllEnvs())

const fixture = (name: string) => JSON.parse(fs.readFileSync(
  path.join(__dirname, "../../integrations/__fixtures__/experian", name), "utf8"))

const request: BureauEnquiryRequest = {
  tenantId: "tenant-synthetic",
  consumer: { idNumber: "9001015800088", firstName: "Synthetic", lastName: "Applicant", gender: "M", dateOfBirth: null },
  purpose: "AFFORDABILITY_ASSESSMENT",
  consent: { reference: "ClientConsent:synthetic" },
  reference: "application-synthetic",
}
const context = { credentials: null, signal: new AbortController().signal }

async function rejection(promise: Promise<unknown>): Promise<BureauProviderError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof BureauProviderError) return error
    throw error
  }
  throw new Error("expected a BureauProviderError")
}

describe("Experian adapter", () => {
  it("normalises a real UAT report without moving its obligations total", () => {
    const parsed = parseEnquiryResult(fixture("adverse.json")) as ExperianResult & { ok: true }
    const report = experianReport(parsed)
    expect(report.score).toMatchObject({ value: 574, band: { min: 480, max: 710 }, riskGrade: "VERY HIGH RISK" })
    expect(report.defaults).toContain("WRITTEN OFF")
    expect(report.tradelines).toHaveLength(parsed.accounts!.length)
    expect(report.tradelines.every((t) => t.open === (t.status === "OPEN/CURRENT"))).toBe(true)
    // The bureau obligation affordability reads is the parser's own total.
    expect(bureauInstalmentTotalCents(report)).toBe(612_600)
    expect(report.rawSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(report.simulated).toBe(false)
  })

  it("carries the hard-stop flags through", () => {
    expect(experianReport(parseEnquiryResult(fixture("deceased.json")) as ExperianResult & { ok: true }))
      .toMatchObject({ deceased: true, score: { value: null, unscoreable: true } })
    expect(experianReport(parseEnquiryResult(fixture("judgements.json")) as ExperianResult & { ok: true }).hasJudgement).toBe(true)
  })

  it("labels its dry-run report simulated, with Experian's own guard as the source", async () => {
    const report = await experianBureau.enquiry(request, context)
    expect(report).toMatchObject({ provider: "experian", simulated: true, simulationSource: "experian", score: { value: 645 } })
    expect(bureauInstalmentTotalCents(report)).toBe(0)
    expect(bureauObligationsKnown(reportObligations(report))).toBe(true)
  })
})

describe("simulated bureau", () => {
  it("is deterministic per ID number and reaches every scenario", () => {
    expect(simulatedScenarioFor("9001015800086")).toBe(simulatedScenarioFor("9001015800086"))
    const seen = new Set<string>()
    for (let n = 0; n < 200; n++) seen.add(simulatedScenarioFor(`80010150000${String(n).padStart(2, "0")}`))
    expect([...seen].sort()).toEqual([...SIMULATED_SCENARIOS].sort())
  })

  it("labels every report simulated under its own guard key", async () => {
    const report = await simulatedBureau.enquiry(request, context)
    expect(report).toMatchObject({ provider: "simulated", simulated: true, simulationSource: "simulated-bureau" })
    expect(report.tradelines.every((t) => t.subscriber.includes("SIMULATED"))).toBe(true)
  })

  it("is refused on a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    // Experian's sandbox signal does not open the simulator.
    vi.stubEnv("EXPERIAN_ENV", "UAT")
    expect((await rejection(simulatedBureau.enquiry(request, context))).code).toBe("SIMULATION_FORBIDDEN")
  })

  it("runs on a deployed build only when named in SIMULATED_INTEGRATIONS", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "transunion,simulated-bureau")
    await expect(simulatedBureau.enquiry(request, context)).resolves.toMatchObject({ simulated: true })
  })
})

describe("skeleton bureaus", () => {
  it.each(SKELETON_BUREAUS.map((b) => [b.id, b] as const))("%s: NOT_CONFIGURED without credentials", async (_id, bureau) => {
    const error = await rejection(bureau.enquiry(request, context))
    expect(error.code).toBe("NOT_CONFIGURED")
    expect(error.message).toContain("username")
  })

  it.each(SKELETON_BUREAUS.map((b) => [b.id, b] as const))("%s: NOT_IMPLEMENTED with credentials", async (_id, bureau) => {
    const credentials = { username: "synthetic", password: "synthetic", endpointUrl: "https://bureau.invalid" }
    const error = await rejection(bureau.enquiry(request, { ...context, credentials }))
    expect(error.code).toBe("NOT_IMPLEMENTED")
    expect(bureau.capabilities.implemented).toBe(false)
  })
})
