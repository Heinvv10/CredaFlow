import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ regime: vi.fn(), disburse: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findFirst: h.regime } } }))
vi.mock("./disburse", () => ({ disburseKeyFactsLoan: h.disburse }))

import { keyFactsDisbursement } from "./disburse-response"
import { KEY_FACTS_PAYOUT_NOTE } from "./payout-terms"

const args = { tenantId: "t1", applicationId: "a1", user: { id: "u1", email: "u@test.invalid" }, bankRef: "LS-1" }

describe("the disburse route's answer for a key-facts application", () => {
  beforeEach(() => { vi.clearAllMocks(); h.regime.mockResolvedValue({ disclosureRegime: "KEY_FACTS" }) })

  it("is nothing for an NCA application, which carries on down the NCA route", async () => {
    h.regime.mockResolvedValue({ disclosureRegime: "NCA_PASQ" })
    expect(await keyFactsDisbursement(args)).toBeNull()
    expect(h.disburse).not.toHaveBeenCalled()
  })

  it("passes the bank reference on and says the payout was manual", async () => {
    h.disburse.mockResolvedValue({ ok: true, loanId: "l1", loanRef: "LN-1", disbursementCents: 500_000, payoutChannel: "MANUAL" })
    const res = await keyFactsDisbursement(args)
    expect(h.disburse).toHaveBeenCalledWith(args)
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ success: true, loanId: "l1", loanRef: "LN-1", payout: { channel: "MANUAL", note: KEY_FACTS_PAYOUT_NOTE } })
  })

  it("answers a refusal with its status, its precondition (the route audits it) and the affordability reason", async () => {
    h.disburse.mockResolvedValue({ ok: false, status: 422, error: "No.", precondition: "unchanged_affordability", affordabilitySnapshot: "changed" })
    const res = await keyFactsDisbursement(args)
    expect(res!.status).toBe(422)
    expect(await res!.json()).toEqual({ error: "No.", disbursementPrecondition: "unchanged_affordability", affordabilitySnapshot: "changed" })
  })
})
