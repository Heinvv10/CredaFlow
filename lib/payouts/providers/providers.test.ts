import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const disburseFunds = vi.hoisted(() => vi.fn())
vi.mock("@/lib/integrations/netcash", () => ({ disburseFunds }))

import { getPayoutProvider, registeredPayoutProviders } from "../registry"
import { netcashPayouts } from "./netcash"
import { simulatedPayouts } from "./simulated"
import type { PayoutRequest } from "../types"

const request = (accountNumber = "62000001234"): PayoutRequest => ({
  tenantId: "t-1",
  beneficiary: { accountHolder: "Test Person", bankName: "FNB", branchCode: "250655", accountNumber, accountType: "SAVINGS" },
  amountCents: 150_075,
  reference: "LN-1",
  idempotencyKey: "disburse:app-1",
})

describe("Netcash payout adapter", () => {
  beforeEach(() => disburseFunds.mockReset())

  it("passes rands and the verified account to disburseFunds", async () => {
    disburseFunds.mockResolvedValue({ ok: true, transactionId: "NC-77" })
    expect(await netcashPayouts.initiatePayout(request())).toEqual({ kind: "accepted", state: "SUBMITTED", providerReference: "NC-77" })
    expect(disburseFunds).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t-1", accountHolder: "Test Person", accountNumber: "62000001234", bankCode: "250655", amount: 1500.75, reference: "LN-1",
    }))
  })

  it("keeps the dry-run: a simulated acceptance is labelled simulated", async () => {
    disburseFunds.mockResolvedValue({ ok: true, transactionId: "dry-run", simulated: true })
    expect(await netcashPayouts.initiatePayout(request())).toMatchObject({ kind: "accepted", simulated: true, providerReference: "dry-run-disburse:app-1" })
  })

  it("treats only 'not configured' as definitely unsent; any other failure is unknown", async () => {
    disburseFunds.mockResolvedValue({ ok: false, error: "Netcash not configured", notSent: true })
    expect(await netcashPayouts.initiatePayout(request())).toEqual({ kind: "rejected", reason: "Netcash not configured" })
    disburseFunds.mockResolvedValue({ ok: false, error: "fetch failed" })
    expect(await netcashPayouts.initiatePayout(request())).toEqual({ kind: "unknown", reason: "fetch failed" })
  })
})

describe("simulated payout provider", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("drives each path from the account suffix", async () => {
    expect(await simulatedPayouts.initiatePayout(request("1230000"))).toMatchObject({ kind: "rejected" })
    expect(await simulatedPayouts.initiatePayout(request("1239999"))).toMatchObject({ kind: "unknown" })
    const ok = await simulatedPayouts.initiatePayout(request("1231234"))
    expect(ok).toMatchObject({ kind: "accepted", state: "SUBMITTED", simulated: true })
  })

  it("is refused on a deployed build unless explicitly allowed", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "")
    await expect(simulatedPayouts.initiatePayout(request())).rejects.toThrow(/not permitted on a deployed build/)
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-payout")
    await expect(simulatedPayouts.initiatePayout(request())).resolves.toMatchObject({ kind: "accepted" })
  })
})

describe("payout registry", () => {
  it("lists the typed skeletons but refuses to dispatch to them", () => {
    const ids = registeredPayoutProviders().map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(["netcash", "simulated", "capitec-pay", "payshap", "cash-voucher"]))
    for (const id of ["capitec-pay", "payshap", "cash-voucher"]) {
      expect(() => getPayoutProvider(id)).toThrow(/not implemented/)
    }
    expect(() => getPayoutProvider(null)).toThrow(/No payout provider configured/)
    expect(() => getPayoutProvider("nope")).toThrow(/Unknown payout provider/)
  })
})
