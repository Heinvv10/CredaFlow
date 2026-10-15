import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetSimulatedRail, simulatedCollections } from "./simulated"
import { getCollectionProvider } from "./registry"
import type { AwaitingInstruction, CreateMandateReq } from "./types"

const mandateReq = (accountNumber: string, mandateReference = `mandate-${accountNumber}`): CreateMandateReq => ({
  mandateReference,
  loanReference: "LN-TEST-1",
  debtor: { firstName: "Test", lastName: "Debtor", idNumber: "9001015800086", phone: "0820000000" },
  account: { accountHolder: "T Debtor", idNumber: "9001015800086", bankName: "Test Bank", branchCode: "250655", accountNumber, accountType: "CHEQUE" },
  amountType: "VARIABLE",
  instalmentAmountCents: 100_000,
  maxCollectionAmountCents: 150_000,
  debitDayOfMonth: 25,
  authType: "TT1",
  frequency: "MONTHLY",
  firstCollectionDate: new Date("2026-10-26T00:00:00Z"),
  trackingDays: 3,
  adjustment: "NEVER",
})

const awaiting = (amountCents: number, actionDate = "2026-10-26"): AwaitingInstruction => ({
  instructionRef: `CI-${amountCents}`, mandateRef: "SIM-A-mandate-1", batchRef: "SIM-B-x", amountCents,
  actionDate: new Date(`${actionDate}T00:00:00Z`),
})
const window = (to: string, list: AwaitingInstruction[]) => ({ from: new Date("2026-09-01T00:00:00Z"), to: new Date(to), awaiting: list })

describe("simulatedCollections", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    resetSimulatedRail()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("is registered under 'simulated'", () => {
    expect(getCollectionProvider({ collectionProvider: "simulated", avsProvider: null }).id).toBe("simulated")
  })

  it("registers asynchronously, like a file-based rail, and scripts the debtor's answer by account suffix", async () => {
    for (const [account, expected] of [["62000000001", "AUTHENTICATED"], ["62000000009", "REJECTED"], ["62000000008", "EXPIRED"]] as const) {
      const req = mandateReq(account)
      expect(await simulatedCollections.createMandate(req, {})).toEqual({ providerMandateRef: null, status: "PENDING_REGISTRATION", simulated: true })
      const registered = await simulatedCollections.findMandate!(req.mandateReference, {})
      expect(registered).toMatchObject({ status: "PENDING_AUTH", simulated: true })
      expect(await simulatedCollections.getMandateStatus(registered!.providerMandateRef!, {})).toBe(expected)
    }
  })

  it("has no record of a mandate it was never sent", async () => {
    expect(await simulatedCollections.findMandate!("never-sent", {})).toBeNull()
  })

  it("reports a cancelled mandate as CANCELLED", async () => {
    const req = mandateReq("62000000001")
    await simulatedCollections.createMandate(req, {})
    const ref = (await simulatedCollections.findMandate!(req.mandateReference, {}))!.providerMandateRef!
    await simulatedCollections.cancelMandate(ref, {})
    expect(await simulatedCollections.getMandateStatus(ref, {})).toBe("CANCELLED")
  })

  it("takes a batch for later loading, and loads every instruction in it", async () => {
    const submit = await simulatedCollections.collect(
      [{ instructionRef: "CI-1", mandateRef: "SIM-A-m", amountCents: 100_000, actionDate: new Date("2026-10-26T00:00:00Z"), trackingDays: 3 }], {})
    expect(submit).toMatchObject({ accepted: [], rejected: [], awaitingLoadReport: true, simulated: true })
    expect(await simulatedCollections.getBatchLoadReport!({ batchRef: submit.batchRef, instructionRefs: ["CI-1"] }, {}))
      .toEqual({ state: "LOADED", accepted: ["CI-1"], rejected: [] })
  })

  it("answers each instruction by its cents, once the engine's clock has passed its action date", async () => {
    const results = await simulatedCollections.fetchResults(
      window("2026-10-27T08:00:00Z", [awaiting(100_000), awaiting(100_001), awaiting(100_003), awaiting(100_005), awaiting(100_000, "2026-11-25")]), {})
    expect(results.map((r) => [r.instructionRef, r.status, r.reason, r.settledAmountCents, r.simulated])).toEqual([
      ["CI-100000", "PAID", null, 100_000, true],
      ["CI-100001", "UNPAID", "INSUFFICIENT_FUNDS", null, true],
      ["CI-100003", "DISPUTED", "PAYMENT_STOPPED", null, true],
    ])
  })

  it("uses the engine's clock, not the wall clock", async () => {
    expect(await simulatedCollections.fetchResults(window("2026-10-25T08:00:00Z", [awaiting(100_000)]), {})).toEqual([])
  })

  it("is the same answer every time", async () => {
    const w = window("2026-10-27T08:00:00Z", [awaiting(100_001)])
    expect(await simulatedCollections.fetchResults(w, {})).toEqual(await simulatedCollections.fetchResults(w, {}))
  })

  it("refuses on an undeclared deployed build with a NOT_CONFIGURED error: nothing was sent, safe to release", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(simulatedCollections.createMandate(mandateReq("62000000001"), {}))
      .rejects.toMatchObject({ name: "CollectionProviderError", code: "NOT_CONFIGURED", message: expect.stringMatching(/simulated-collections/) })
    await expect(simulatedCollections.collect([], {})).rejects.toMatchObject({ code: "NOT_CONFIGURED" })
  })

  it("runs on a deployed build that names it in SIMULATED_INTEGRATIONS (the demo stacks)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections")
    await expect(simulatedCollections.createMandate(mandateReq("62000000001"), {})).resolves.toMatchObject({ simulated: true })
  })
})
