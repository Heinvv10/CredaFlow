import { describe, expect, it } from "vitest"
import { dpdBand, exceptionsFingerprint, recordedExceptions, worsenedSince, type RecordedException } from "./deal-exception-severity"

const arrears = (over: Partial<Extract<RecordedException, { kind: "ARREARS" }>> = {}): RecordedException =>
  ({ key: "ARREARS:loan-1", kind: "ARREARS", status: "ACTIVE", daysInArrears: 10, arrearsCents: 50_000, ...over })

describe("exception severity (security review of #151)", () => {
  it("an approval answered for 10 days and R500 does not cover the loan once it defaults, moves band, or the arrears grow", () => {
    const answered = arrears()
    expect(worsenedSince(answered, arrears({ status: "DEFAULTED" }))).toMatch(/ACTIVE to DEFAULTED/)
    expect(worsenedSince(answered, arrears({ status: "WRITTEN_OFF" }))).toMatch(/to WRITTEN_OFF/)
    expect(worsenedSince(answered, arrears({ daysInArrears: 35 }))).toMatch(/days in arrears moved from 10 to 35/)
    expect(worsenedSince(answered, arrears({ arrearsCents: 50_001 }))).toMatch(/amount grew/)
    expect(worsenedSince(arrears({ status: "DEFAULTED" }), arrears({ status: "PENDING_WRITE_OFF" }))).toMatch(/DEFAULTED to PENDING_WRITE_OFF/)
  })

  it("the same or a milder state stays covered", () => {
    const answered = arrears({ status: "DEFAULTED", daysInArrears: 95, arrearsCents: 100_000 })
    expect(worsenedSince(answered, answered)).toBeNull()
    expect(worsenedSince(answered, arrears({ status: "DEFAULTED", daysInArrears: 150, arrearsCents: 100_000 }))).toBeNull() // still 90+
    expect(worsenedSince(answered, arrears({ status: "RESTRUCTURED", daysInArrears: 5, arrearsCents: 1_000 }))).toBeNull()
  })

  it("a bureau exception is covered only for the outcome answered", () => {
    const skipped: RecordedException = { key: "BUREAU:c-1", kind: "BUREAU", outcome: "skipped:CONSENT_MISSING" }
    expect(worsenedSince(skipped, skipped)).toBeNull()
    expect(worsenedSince(skipped, { ...skipped, outcome: "failed:timeout" })).toMatch(/bureau outcome changed/)
  })

  it("the fingerprint follows status and DPD band, not the exact amount", () => {
    const base = exceptionsFingerprint([arrears()])
    expect(exceptionsFingerprint([arrears({ arrearsCents: 60_000 })])).toBe(base)
    expect(exceptionsFingerprint([arrears({ daysInArrears: 31 })])).not.toBe(base)
    expect(exceptionsFingerprint([arrears({ status: "DEFAULTED" })])).not.toBe(base)
    expect([0, 1, 29, 30, 59, 60, 89, 90].map(dpdBand)).toEqual([0, 1, 1, 2, 2, 3, 3, 4])
  })

  it("reads only well-formed stored entries", () => {
    expect(recordedExceptions([arrears(), { key: 3 }, null, "x"])).toEqual([arrears()])
    expect(recordedExceptions({})).toEqual([])
  })
})
