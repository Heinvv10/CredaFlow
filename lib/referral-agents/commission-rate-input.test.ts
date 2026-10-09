import { describe, it, expect } from "vitest"
import { parseReferralCommissionInput, REFERRAL_COMMISSION_BPS_MAX } from "./commission-rate-input"

describe("parseReferralCommissionInput", () => {
  it("accepts a whole-number bps in range", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: 100 })
    expect(r).toEqual({ ok: true, values: { referralCommissionBps: 100 } })
  })

  it("accepts 0 — commission off", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: 0 })
    expect(r.ok).toBe(true)
  })

  it("accepts the ceiling", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: REFERRAL_COMMISSION_BPS_MAX })
    expect(r.ok).toBe(true)
  })

  // A fractional bps truncates on the way into an Int column, silently
  // mispricing every future accrual. It must be refused, not rounded.
  it("rejects a fractional bps rather than rounding it", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: 100.5 })
    expect(r).toEqual({ ok: false, error: "referralCommissionBps must be an integer." })
  })

  it("rejects a negative bps", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: -1 })
    expect(r.ok).toBe(false)
  })

  it("rejects a bps above the ceiling", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: REFERRAL_COMMISSION_BPS_MAX + 1 })
    expect(r.ok).toBe(false)
  })

  it("rejects a numeric string", () => {
    const r = parseReferralCommissionInput({ referralCommissionBps: "100" })
    expect(r).toEqual({ ok: false, error: "referralCommissionBps must be an integer." })
  })

  it("rejects NaN and Infinity", () => {
    expect(parseReferralCommissionInput({ referralCommissionBps: NaN }).ok).toBe(false)
    expect(parseReferralCommissionInput({ referralCommissionBps: Infinity }).ok).toBe(false)
  })

  // An absent key must not be read as "set it to 0" — that is exactly the
  // silent-disable this whole change exists to prevent.
  it("rejects a missing key rather than defaulting to 0", () => {
    const r = parseReferralCommissionInput({})
    expect(r.ok).toBe(false)
  })

  it("rejects a non-object body", () => {
    expect(parseReferralCommissionInput(null).ok).toBe(false)
    expect(parseReferralCommissionInput("100").ok).toBe(false)
  })

  it("ceiling is 10000 bps — 100%", () => {
    expect(REFERRAL_COMMISSION_BPS_MAX).toBe(10000)
  })
})
