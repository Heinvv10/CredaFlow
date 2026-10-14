import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatchPayout } from "./dispatch"
import { fakePayoutDb, payoutRow } from "./payouts.test-helpers"
import { registerPayoutProvider } from "./registry"
import { simulatedPayouts } from "./providers/simulated"
import type { InitiateResult, PayoutProvider } from "./types"

const actor = { id: "u-1", email: "staff@test.invalid" }

function stubProvider(answer: () => Promise<InitiateResult>) {
  const initiatePayout = vi.fn(answer)
  const provider: PayoutProvider = {
    id: "stub", displayName: "Stub",
    capabilities: { implemented: true, statusQuery: false, webhooks: false },
    initiatePayout,
    getPayoutStatus: async () => ({ kind: "unsupported" }),
  }
  registerPayoutProvider(provider)
  return initiatePayout
}

afterEach(() => registerPayoutProvider(simulatedPayouts))

describe("dispatchPayout — claim before send", () => {
  it("claims PENDING -> SUBMITTING (audited) before the provider is called", async () => {
    const { db, rows, audits } = fakePayoutDb([payoutRow({ provider: "stub" })])
    const seen: string[] = []
    stubProvider(async () => {
      seen.push(rows[0].status)
      expect(audits.map((a) => (a.newValue as { status: string }).status)).toEqual(["SUBMITTING"])
      return { kind: "accepted", state: "SUBMITTED", providerReference: "ref-1" }
    })

    const out = await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })

    expect(seen).toEqual(["SUBMITTING"])
    expect(out).toEqual({ kind: "sent", status: "SUBMITTED", result: "accepted" })
    expect(rows[0]).toMatchObject({ status: "SUBMITTED", providerReference: "ref-1" })
    expect(rows[0].submittedAt).toBeInstanceOf(Date)
  })

  it("sends once when two dispatchers race for the same payout", async () => {
    const { db } = fakePayoutDb([payoutRow({ provider: "stub" })])
    const send = stubProvider(async () => ({ kind: "accepted", state: "SUBMITTED", providerReference: "ref-1" }))

    const [a, b] = await Promise.all([
      dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor }),
      dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor }),
    ])

    expect(send).toHaveBeenCalledTimes(1)
    expect([a.kind, b.kind].sort()).toEqual(["not_claimed", "sent"])
  })

  it("never re-sends a payout that was already claimed", async () => {
    for (const status of ["SUBMITTING", "SUBMITTED", "NEEDS_REVIEW", "FAILED", "PAID"] as const) {
      const { db } = fakePayoutDb([payoutRow({ provider: "stub", status })])
      const send = stubProvider(async () => ({ kind: "accepted", state: "PAID", providerReference: "x" }))
      expect(await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })).toEqual({ kind: "not_claimed", status })
      expect(send).not.toHaveBeenCalled()
    }
  })

  it("records a definite rejection as FAILED", async () => {
    const { db, rows } = fakePayoutDb([payoutRow({ provider: "stub" })])
    stubProvider(async () => ({ kind: "rejected", reason: "bad branch" }))
    await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })
    expect(rows[0]).toMatchObject({ status: "FAILED", failureReason: "bad branch" })
  })

  it("turns an unknown outcome or a throw into NEEDS_REVIEW, not a retry", async () => {
    for (const answer of [
      async (): Promise<InitiateResult> => ({ kind: "unknown", reason: "timeout" }),
      async (): Promise<InitiateResult> => { throw new Error("socket hang up") },
    ]) {
      const { db, rows } = fakePayoutDb([payoutRow({ provider: "stub" })])
      const send = stubProvider(answer)
      await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })
      expect(rows[0].status).toBe("NEEDS_REVIEW")
      expect(await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })).toMatchObject({ kind: "not_claimed" })
      expect(send).toHaveBeenCalledTimes(1)
    }
  })

  it("leaves a payout PENDING (unsent) when its channel cannot pay", async () => {
    const { db, rows } = fakePayoutDb([payoutRow({ provider: "payshap" })])
    const out = await dispatchPayout(db, { tenantId: "t-1", payoutId: "po-1", actor })
    expect(out.kind).toBe("not_sendable")
    expect(rows[0].status).toBe("PENDING")
  })

  it("does not touch another tenant's payout", async () => {
    const { db, rows } = fakePayoutDb([payoutRow({ provider: "stub" })])
    const send = stubProvider(async () => ({ kind: "accepted", state: "PAID", providerReference: "x" }))
    expect(await dispatchPayout(db, { tenantId: "t-2", payoutId: "po-1", actor })).toEqual({ kind: "not_claimed", status: null })
    expect(send).not.toHaveBeenCalled()
    expect(rows[0].status).toBe("PENDING")
  })
})
