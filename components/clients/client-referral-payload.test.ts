import { describe, expect, it } from "vitest"
import { referralPayloadFields, isReferralSaveBlocked } from "./client-referral-payload"

const IMPACT = { blocked: false, totalAccrueCents: 2_200, totalReverseCents: 900 }

/** A real FormData, so the key-presence contract is exercised, not simulated. */
function formData(entries: Record<string, string> = {}) {
  const fd = new FormData()
  for (const [key, value] of Object.entries(entries)) fd.set(key, value)
  return fd
}

describe("referralPayloadFields", () => {
  // ReferralAgentField renders its <select> only once the agent list has loaded,
  // so an absent key means "leave the attribution alone". Sending null would
  // erase an agent's commission trail on an unrelated edit.
  it("contributes nothing when the field never rendered", () => {
    expect(referralPayloadFields(formData({ firstName: "Sipho" }), null)).toEqual({})
  })

  it("contributes nothing even when an impact is somehow still in state", () => {
    expect(referralPayloadFields(formData({ firstName: "Sipho" }), IMPACT)).toEqual({})
  })

  it("sends the selected code and the totals the operator was shown", () => {
    expect(referralPayloadFields(formData({ referralCodeId: "code-b" }), IMPACT)).toEqual({
      referralCodeId: "code-b",
      referralImpact: { totalAccrueCents: 2_200, totalReverseCents: 900 },
    })
  })

  // The empty option is "no referral agent", which is a real instruction to
  // clear — distinct from the key being absent entirely.
  it("sends an explicit null when the agent is cleared", () => {
    const payload = referralPayloadFields(formData({ referralCodeId: "" }), IMPACT)
    expect(payload.referralCodeId).toBeNull()
    expect(payload.referralImpact).toEqual({
      totalAccrueCents: 2_200, totalReverseCents: 900,
    })
  })

  // LOAD-FAILURE CONTRACT: a failed preview leaves no approved totals. The save
  // still goes through, unbound — the accrual is computed server-side regardless,
  // and blocking an unrelated client edit on a failed preview would be worse.
  it("sends the code without totals when there was no usable preview", () => {
    expect(referralPayloadFields(formData({ referralCodeId: "code-b" }), null)).toEqual({
      referralCodeId: "code-b",
    })
  })

  // Only the two figures the PUT compares. Sending `blocked` would put a UI
  // concern into a money contract.
  it("sends only the two totals the write is bound to", () => {
    const payload = referralPayloadFields(formData({ referralCodeId: "code-b" }), IMPACT)
    expect(Object.keys(payload.referralImpact!).sort())
      .toEqual(["totalAccrueCents", "totalReverseCents"])
  })

  it("carries a zero total through rather than dropping it as falsy", () => {
    const payload = referralPayloadFields(
      formData({ referralCodeId: "code-b" }),
      { blocked: false, totalAccrueCents: 0, totalReverseCents: 0 },
    )
    expect(payload.referralImpact).toEqual({
      totalAccrueCents: 0, totalReverseCents: 0,
    })
  })
})

describe("isReferralSaveBlocked", () => {
  it("blocks only on a blocker the server actually returned", () => {
    expect(isReferralSaveBlocked({ ...IMPACT, blocked: true })).toBe(true)
  })

  it("does not block on an ordinary preview", () => {
    expect(isReferralSaveBlocked(IMPACT)).toBe(false)
  })

  it("does not block when there is no preview at all", () => {
    expect(isReferralSaveBlocked(null)).toBe(false)
  })
})
