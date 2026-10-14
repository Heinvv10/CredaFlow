import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { simulatedCollections } from "./simulated"
import { getCollectionProvider } from "./registry"
import type { AwaitingInstruction, CreateMandateReq } from "./types"

const mandateReq = (accountNumber: string): CreateMandateReq => ({
  mandateReference: "mandate-1",
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

describe("simulatedCollections", () => {
  beforeEach(() => vi.unstubAllEnvs())
  afterEach(() => vi.useRealTimers())

  it("is registered under 'simulated'", () => {
    expect(getCollectionProvider({ collectionProvider: "simulated", avsProvider: null }).id).toBe("simulated")
  })

  it("authorises a mandate by default and scripts rejection and expiry by account suffix", async () => {
    for (const [account, expected] of [["62000000001", "AUTHENTICATED"], ["62000000009", "REJECTED"], ["62000000008", "EXPIRED"]] as const) {
      const handle = await simulatedCollections.createMandate(mandateReq(account), {})
      expect(handle).toMatchObject({ status: "PENDING_AUTH", simulated: true })
      expect(await simulatedCollections.getMandateStatus(handle.providerMandateRef!, {})).toBe(expected)
    }
  })

  it("accepts a batch and answers each instruction by its cents, once the action date has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T08:00:00Z") })
    const submit = await simulatedCollections.collect(
      [{ instructionRef: "CI-1", mandateRef: "SIM-A-m", amountCents: 100_000, actionDate: new Date("2026-10-26T00:00:00Z"), trackingDays: 3 }], {})
    expect(submit).toMatchObject({ accepted: ["CI-1"], rejected: [], simulated: true })

    const results = await simulatedCollections.fetchResults({
      from: new Date("2026-09-01T00:00:00Z"),
      awaiting: [awaiting(100_000), awaiting(100_001), awaiting(100_003), awaiting(100_005), awaiting(100_000, "2026-11-25")],
    }, {})
    expect(results.map((r) => [r.instructionRef, r.status, r.reason, r.settledAmountCents, r.simulated])).toEqual([
      ["CI-100000", "PAID", null, 100_000, true],
      ["CI-100001", "UNPAID", "INSUFFICIENT_FUNDS", null, true],
      ["CI-100003", "DISPUTED", "PAYMENT_STOPPED", null, true],
    ])
  })

  it("is the same answer every time (stateless)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T08:00:00Z") })
    const window = { from: new Date("2026-09-01T00:00:00Z"), awaiting: [awaiting(100_001)] }
    expect(await simulatedCollections.fetchResults(window, {})).toEqual(await simulatedCollections.fetchResults(window, {}))
  })

  it("refuses every call on a deployed build that has not declared it", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(simulatedCollections.createMandate(mandateReq("62000000001"), {})).rejects.toThrow(/simulated-collections/)
    await expect(simulatedCollections.fetchResults({ from: new Date() }, {})).rejects.toThrow(/not permitted on a deployed build/)
  })

  it("runs on a deployed build that names it in SIMULATED_INTEGRATIONS (the demo stacks)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-collections")
    await expect(simulatedCollections.createMandate(mandateReq("62000000001"), {})).resolves.toMatchObject({ simulated: true })
  })
})
