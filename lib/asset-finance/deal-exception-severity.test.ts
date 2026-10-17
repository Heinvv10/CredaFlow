import { describe, expect, it } from "vitest"
import {
  arrearsGrowth, dpdBand, exceptionsFingerprint, growthBeyondCap, MAX_ARREARS_GROWTH_INSTALMENTS, recordedExceptions, regularInstalmentCents,
  worsenedSince, type RecordedException,
} from "./deal-exception-severity"

const arrears = (over: Partial<Extract<RecordedException, { kind: "ARREARS" }>> = {}): RecordedException =>
  ({ key: "ARREARS:loan-1", kind: "ARREARS", status: "ACTIVE", daysInArrears: 10, arrearsCents: 50_000, ...over })

describe("exception severity (security review of #151)", () => {
  it("an approval answered for 10 days and R500 does not cover the loan once it defaults or moves DPD band", () => {
    const answered = arrears()
    expect(worsenedSince(answered, arrears({ status: "DEFAULTED" }))).toMatch(/ACTIVE to DEFAULTED/)
    expect(worsenedSince(answered, arrears({ status: "WRITTEN_OFF" }))).toMatch(/to WRITTEN_OFF/)
    expect(worsenedSince(answered, arrears({ daysInArrears: 35 }))).toMatch(/days in arrears moved from 10 to 35/)
    expect(worsenedSince(arrears({ status: "DEFAULTED" }), arrears({ status: "PENDING_WRITE_OFF" }))).toMatch(/DEFAULTED to PENDING_WRITE_OFF/)
  })

  it("the same or a milder state stays covered", () => {
    const answered = arrears({ status: "DEFAULTED", daysInArrears: 95, arrearsCents: 100_000 })
    expect(worsenedSince(answered, answered)).toBeNull()
    expect(worsenedSince(answered, arrears({ status: "DEFAULTED", daysInArrears: 150, arrearsCents: 100_000 }))).toBeNull() // still 90+
    expect(worsenedSince(answered, arrears({ status: "RESTRUCTURED", daysInArrears: 5, arrearsCents: 1_000 }))).toBeNull()
  })

  it("a larger amount overdue alone is not worse (policy, follow-up to #151): it is reported as growth for the audit", () => {
    const answered = arrears()
    // The next instalment fell due unpaid: more overdue, same status, same band.
    const later = arrears({ daysInArrears: 25, arrearsCents: 120_000 })
    expect(worsenedSince(answered, later)).toBeNull()
    expect(arrearsGrowth(answered, later)).toEqual({
      key: "ARREARS:loan-1", approvedArrearsCents: 50_000, currentArrearsCents: 120_000, approvedDaysInArrears: 10, currentDaysInArrears: 25,
    })
    expect(arrearsGrowth(answered, arrears({ arrearsCents: 50_000 }))).toBeNull()
    expect(arrearsGrowth(answered, arrears({ arrearsCents: 10_000 }))).toBeNull()
    expect(arrearsGrowth({ key: "BUREAU:c-1", kind: "BUREAU", outcome: "x" }, { key: "BUREAU:c-1", kind: "BUREAU", outcome: "x" })).toBeNull()
  })

  it(`growth beyond ${MAX_ARREARS_GROWTH_INSTALMENTS} regular instalments is refused; the regular instalment ignores a balloon row`, () => {
    // 36 rentals of R1,000 and a R50,000 balloon: the regular instalment is R1,000.
    const regular = regularInstalmentCents([...Array(36).fill(100_000), 5_000_000])
    expect(regular).toBe(100_000)
    expect(regularInstalmentCents([100_000, 300_000])).toBe(200_000)
    expect(regularInstalmentCents([])).toBe(0)
    const from = { approvedArrearsCents: 50_000 }
    expect(growthBeyondCap({ ...from, currentArrearsCents: 50_000 + 150_000 }, regular)).toBe(false) // exactly 1.5
    expect(growthBeyondCap({ ...from, currentArrearsCents: 50_000 + 150_001 }, regular)).toBe(true)
    expect(growthBeyondCap({ ...from, currentArrearsCents: 50_000 + 5_000_000 }, regular)).toBe(true) // the balloon fell due unpaid
    expect(growthBeyondCap({ ...from, currentArrearsCents: 50_001 }, 0)).toBe(true) // no schedule: any growth
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
