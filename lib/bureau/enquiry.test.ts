import { describe, expect, it, vi } from "vitest"
import { runBureauEnquiry, type RunBureauEnquiryArgs } from "./enquiry"
import { bureauProviderOrder, getBureauProvider, registeredBureauIds } from "./registry"
import { simulatedReport } from "./providers/simulated"
import { BureauProviderError, type BureauProvider, type BureauReport } from "./types"

const request: RunBureauEnquiryArgs["request"] = {
  tenantId: "tenant-synthetic",
  consumer: { idNumber: "9001015800086", firstName: "Synthetic", lastName: "Applicant", gender: null, dateOfBirth: null },
  purpose: "AFFORDABILITY_ASSESSMENT",
  consent: { reference: "ClientConsent:synthetic" },
  reference: "application-synthetic",
}

const report = (provider: string): BureauReport => ({ ...simulatedReport("CLEAN"), provider })

function fake(id: string, behaviour: () => Promise<BureauReport>, credentialFields: string[] = []): BureauProvider & { calls: number } {
  const provider = {
    id,
    displayName: id.toUpperCase(),
    capabilities: { score: null, tradelines: true, judgements: false, defaults: false, enquiryCount: false, pep: false, fraud: false, implemented: true },
    credentialFields,
    calls: 0,
    async enquiry() {
      provider.calls++
      return behaviour()
    },
  }
  return provider
}

function run(order: string[], providers: BureauProvider[], extra: Partial<RunBureauEnquiryArgs> = {}) {
  const byId = new Map(providers.map((p) => [p.id, p]))
  return runBureauEnquiry({ request, order, credentialsFor: () => null, resolve: (id) => byId.get(id) ?? null, ...extra })
}

const fails = (code: BureauProviderError["code"]) => () => Promise.reject(new BureauProviderError(code, `${code} from the fake`))

describe("bureauProviderOrder", () => {
  it("keeps the tenant's order, primary first, without blanks or repeats", () => {
    expect(bureauProviderOrder({ bureauProviderOrder: [" XDS", "experian", "", "xds", "simulated"] }))
      .toEqual(["xds", "experian", "simulated"])
  })

  it("refuses a tenant with no bureau enabled", () => {
    expect(() => bureauProviderOrder({ bureauProviderOrder: [] })).toThrow(BureauProviderError)
    expect(() => bureauProviderOrder(null)).toThrow(/No credit bureau is enabled/)
  })

  it("keeps an unknown id, so the run records it rather than skipping it silently", () => {
    expect(bureauProviderOrder({ bureauProviderOrder: ["nobureau"] })).toEqual(["nobureau"])
  })

  it("ships Experian, TransUnion, the simulator and the four skeletons", () => {
    expect(registeredBureauIds().sort()).toEqual(["cpb", "experian", "mydata", "simulated", "transunion", "vccb", "xds"])
    expect(getBureauProvider("xds")?.capabilities.implemented).toBe(false)
  })
})

describe("runBureauEnquiry fallback", () => {
  it("stops at the primary when it answers", async () => {
    const a = fake("a", async () => report("a"))
    const b = fake("b", async () => report("b"))
    const result = await run(["a", "b"], [a, b])
    expect(result.report?.provider).toBe("a")
    expect(result.attempts.map((x) => x.status)).toEqual(["OK"])
    expect(b.calls).toBe(0)
  })

  it("falls back in the tenant's order, recording every failed attempt", async () => {
    const a = fake("a", fails("PROVIDER_ERROR"))
    const b = fake("b", fails("NOT_CONFIGURED"))
    const c = fake("c", async () => report("c"))
    const d = fake("d", async () => report("d"))
    const result = await run(["a", "b", "c", "d"], [a, b, c, d])
    expect(result.attempts.map((x) => [x.attempt, x.provider, x.status])).toEqual([
      [1, "a", "FAILED"], [2, "b", "NOT_CONFIGURED"], [3, "c", "OK"],
    ])
    expect(result.report?.report.provider).toBe("c")
    expect(d.calls).toBe(0)
  })

  it("treats a primary that does not answer in time as failed and moves on", async () => {
    vi.useFakeTimers()
    try {
      const slow = fake("slow", () => new Promise<BureauReport>(() => {}))
      const next = fake("next", async () => report("next"))
      const running = run(["slow", "next"], [slow, next], { timeoutMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await running
      expect(result.attempts.map((x) => [x.provider, x.status])).toEqual([["slow", "TIMEOUT"], ["next", "OK"]])
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not ask another bureau about a subject the first rejected", async () => {
    const a = fake("a", fails("SUBJECT_REJECTED"))
    const b = fake("b", async () => report("b"))
    const result = await run(["a", "b"], [a, b])
    expect(result.report).toBeNull()
    expect(result.attempts.map((x) => x.status)).toEqual(["SUBJECT_REJECTED"])
    expect(b.calls).toBe(0)
  })

  it("records an unknown bureau, a forbidden simulation and an unexpected throw, then falls back", async () => {
    const forbidden = fake("sim", fails("SIMULATION_FORBIDDEN"))
    const broken = fake("broken", () => Promise.reject(new Error("socket hang up")))
    const ok = fake("ok", async () => report("ok"))
    const result = await run(["ghost", "sim", "broken", "ok"], [forbidden, broken, ok])
    expect(result.attempts.map((x) => x.status)).toEqual(["UNKNOWN_PROVIDER", "SIMULATION_FORBIDDEN", "FAILED", "OK"])
  })

  it("returns no report when every bureau fails", async () => {
    const result = await run(["a", "b"], [fake("a", fails("TIMEOUT")), fake("b", fails("NOT_IMPLEMENTED"))])
    expect(result).toMatchObject({ report: null, stale: false })
    expect(result.attempts).toHaveLength(2)
  })

  it("stops as stale before an attempt once the caller's work moved on", async () => {
    const a = fake("a", fails("PROVIDER_ERROR"))
    const b = fake("b", async () => report("b"))
    const checks = [true, false]
    const result = await run(["a", "b"], [a, b], { beforeAttempt: async () => checks.shift() ?? false })
    expect(result).toMatchObject({ stale: true, report: null })
    expect(b.calls).toBe(0)
  })

  it("opens credentials only for a bureau that declares credential fields; a failure there falls back", async () => {
    const credentialsFor = vi.fn(() => { throw new Error("stored bureau credentials could not be opened") })
    const needsCreds = fake("needs", async () => report("needs"), ["username"])
    const noCreds = fake("plain", async () => report("plain"))
    const result = await run(["needs", "plain"], [needsCreds, noCreds], { credentialsFor })
    expect(credentialsFor).toHaveBeenCalledOnce()
    expect(credentialsFor).toHaveBeenCalledWith("needs")
    expect(result.attempts.map((x) => [x.provider, x.status])).toEqual([["needs", "FAILED"], ["plain", "OK"]])
  })

  it("redacts ID numbers from a stored failure message", async () => {
    const result = await run(["a"], [fake("a", fails("PROVIDER_ERROR"))].map((p) => ({
      ...p, enquiry: () => Promise.reject(new BureauProviderError("PROVIDER_ERROR", "no record for 9001015800086")),
    })))
    const attempt = result.attempts[0]
    expect(attempt.status !== "OK" && attempt.error).toBe("no record for [id]")
  })
})
