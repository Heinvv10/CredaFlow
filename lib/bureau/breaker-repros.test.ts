/**
 * The PR #78 review's breaker reproductions, kept as regression tests. Each
 * failed against the first version of the framework.
 */
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bureauMonthlyObligations, bureauObligationsKnown } from "@/lib/affordability/snapshot"
import { approvalBureauCheckWhere, isApprovalBureau } from "@/lib/compliance/bureau"
import { evaluateBureauGate } from "@/lib/decision/bureau-gate"
import { localDirectoryTransport } from "@/lib/bureau-submission/transport"
import type { ExperianResult } from "@/lib/integrations/experian"
import { runBureauEnquiry, type RunBureauEnquiryArgs } from "./enquiry"
import { bureauInstalmentTotalCents } from "./normalise"
import { reportObligations } from "./persist"
import { experianReport } from "./providers/experian"
import { bureauProviderOrder } from "./registry"
import { BureauProviderError, type BureauProvider, type BureauReport } from "./types"

afterEach(() => vi.unstubAllEnvs())

const tl = (instalmentCents: number, status: string | null, open: boolean | null = null) =>
  ({ subscriber: "SYNTHETIC LENDER", accountType: "LOAN", instalmentCents, status, open })
const base = (over: Partial<BureauReport>): BureauReport => ({
  provider: "experian", simulated: false, simulationSource: null, score: null, deceased: false,
  underDebtReview: false, hasJudgement: false, hasNotice: false, defaults: [], enquiriesLast90Days: null,
  pepIndicator: null, fraudIndicator: null, tradelines: [], statedMonthlyInstalmentCents: null, rawSha256: null, ...over,
})
const experian = (accounts: Array<{ status: string | null; instalmentCents: number }>, totalMonthlyObligations = 0) =>
  experianReport({
    ok: true, totalMonthlyObligations,
    accounts: accounts.map((a) => ({ subscriber: "SYNTHETIC BANK", accountType: "PL", ...a })),
  } as ExperianResult & { ok: true })
const request: RunBureauEnquiryArgs["request"] = {
  tenantId: "tenant-synthetic",
  consumer: { idNumber: "8001015009087", firstName: "Synthetic", lastName: "Applicant", gender: null, dateOfBirth: null },
  purpose: "AFFORDABILITY_ASSESSMENT",
  consent: { reference: "ClientConsent:synthetic" },
  reference: "application-synthetic",
}

describe("R1: an Experian account that is not closed counts as debt", () => {
  it("an account with no status counts (unknown is open)", () => {
    expect(bureauInstalmentTotalCents(experian([{ status: null, instalmentCents: 500_000 }]))).toBe(500_000)
  })

  it("an account in arrears counts, though Experian's own total leaves it out", () => {
    expect(bureauInstalmentTotalCents(experian([{ status: "OPEN/ARREARS", instalmentCents: 500_000 }]))).toBe(500_000)
  })

  it("closed and settled accounts do not count", () => {
    const report = experian([
      { status: "ACCOUNT CLOSED", instalmentCents: 300_000 },
      { status: "early settlement", instalmentCents: 200_000 },
      { status: "OPEN/CURRENT", instalmentCents: 100_000 },
    ], 100_000)
    expect(bureauInstalmentTotalCents(report)).toBe(100_000)
  })
})

describe("R2: a negative instalment never offsets real debt", () => {
  it("[+R5 000, -R5 000] is R5 000, not zero", () => {
    expect(bureauInstalmentTotalCents(base({ tradelines: [tl(500_000, "OPEN", true), tl(-500_000, "OPEN", true)] }))).toBe(500_000)
  })

  it("a negative stated total counts as zero", () => {
    expect(bureauInstalmentTotalCents(base({ statedMonthlyInstalmentCents: -900_000, tradelines: [tl(100_000, "OPEN", true)] }))).toBe(100_000)
  })
})

describe("R3: a report with no debt data is not stored as zero debt", () => {
  const silent = base({ score: { value: 600, band: null, riskGrade: null, unscoreable: false, declineReasons: [] } })

  it("stores totalMonthly as null, which reads as unknown", () => {
    const obligations = reportObligations(silent)
    expect(obligations).toMatchObject({ totalMonthly: null })
    expect(bureauObligationsKnown(obligations)).toBe(false)
    // The affordability figure is still a number; the gate is what refuses it.
    expect(bureauMonthlyObligations(obligations)).toBe(0)
  })

  it("the bureau gate refuses it without an audited override", () => {
    const gate = evaluateBureauGate({
      score: 650, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false,
      hasJudgement: false, hasNotice: false, obligations: reportObligations(silent),
    }, { bureauMinScore: 600, bureauBlockAdverse: false })
    expect(gate).toMatchObject({ blocked: true })
  })
})

describe("R4: an approval enquiry never ends on a bureau that cannot approve", () => {
  it("Experian down, TransUnion next: TransUnion is skipped, not called", async () => {
    const tuEnquiry = vi.fn(async () => base({ provider: "transunion" }))
    const down = { id: "experian", displayName: "Experian", credentialFields: [], enquiry: async () => { throw new BureauProviderError("PROVIDER_ERROR", "down") } } as unknown as BureauProvider
    const tu = { id: "transunion", displayName: "TransUnion", credentialFields: [], enquiry: tuEnquiry } as unknown as BureauProvider
    const run = await runBureauEnquiry({
      request, order: ["experian", "transunion"], credentialsFor: () => null,
      resolve: (id) => (id === "experian" ? down : tu), eligible: isApprovalBureau,
    })
    expect(run.report).toBeNull()
    expect(run.attempts.map((a) => [a.provider, a.status])).toEqual([["experian", "FAILED"], ["transunion", "SKIPPED_NOT_APPROVABLE"]])
    expect(tuEnquiry).not.toHaveBeenCalled()
    // And whatever a run returns, the approval read can select it.
    expect(approvalBureauCheckWhere({ tenantId: "t", applicationId: "a", clientId: "c", reviewGeneration: "g", maxAgeDays: 60 }).provider.in)
      .not.toContain("transunion")
  })
})

describe("simulated first in the order on a deployed build", () => {
  it("is refused and the run has no report", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    const run = await runBureauEnquiry({
      request, order: bureauProviderOrder({ bureauProviderOrder: ["simulated", " SIMULATED "] }), credentialsFor: () => null,
    })
    expect(run.report).toBeNull()
    expect(run.attempts.map((a) => a.status)).toEqual(["SIMULATION_FORBIDDEN"])
  })
})

describe("M4: no enquiry without a consent reference", () => {
  it.each([undefined, "", "   "])("refuses %j before calling any bureau", async (reference) => {
    const enquiry = vi.fn()
    const provider = { id: "p", displayName: "P", credentialFields: [], enquiry } as unknown as BureauProvider
    await expect(runBureauEnquiry({
      request: { ...request, consent: { reference } as never }, order: ["p"], credentialsFor: () => null, resolve: () => provider,
    })).rejects.toThrow(/consent reference/)
    expect(enquiry).not.toHaveBeenCalled()
  })
})

describe("the TEST outbox", () => {
  it("dot and path-like file names cannot escape or overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outbox-"))
    const transport = localDirectoryTransport(dir)
    for (const fileName of ["..", ".", "a/../b", "..%2f"]) {
      await expect(transport.deliver({ fileName, content: "x", sha256: "" })).rejects.toMatchObject({ code: "DELIVERY_FAILED", message: expect.stringMatching(/plain file name/) })
    }
    expect(readdirSync(dir)).toEqual([])
  })

  it("is refused on a deployed build", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const transport = localDirectoryTransport(mkdtempSync(join(tmpdir(), "outbox-")))
    await expect(transport.deliver({ fileName: "ok.txt", content: "x", sha256: "" })).rejects.toThrow(/deployed/)
  })
})
