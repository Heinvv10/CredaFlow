import { describe, expect, it } from "vitest"
import {
  rejectImpossibleValueDate,
  rejectUnauthorisedBackdating,
  rejectUnauthorisedRebate,
  valueDateEvidence,
  MAX_UNREVIEWED_REBATE_CENTS,
} from "./value-date"

const START = new Date("2026-03-02T10:23:45.000Z")
const TODAY = new Date("2026-09-18T09:00:00.000Z")
const at = (iso: string) => new Date(iso)
const OVERRIDE = {
  reason: "Branch banked the cash on the 14th; the deposit slip only reached head office today.",
  approvedById: "admin-1",
  approvedByEmail: "admin@acme-lending.example",
}

describe("rejectImpossibleValueDate — bounds no override can buy", () => {
  it("refuses a future date that would bill unearned interest", () => {
    expect(rejectImpossibleValueDate({
      receivedAt: at("2026-09-25T00:00:00.000Z"), asOf: TODAY, loanStartDate: START,
    })).toBe("future")
  })

  it("refuses a value instant later today, but not a date-only today before 02:00 SAST", () => {
    // 10:00 SAST now; the deposit claims 16:00 today.
    const now = at("2026-09-26T08:00:00.000Z")
    expect(rejectImpossibleValueDate({ receivedAt: at("2026-09-26T14:00:00.000Z"), asOf: now, loanStartDate: START })).toBe("future")
    expect(rejectImpossibleValueDate({ receivedAt: at("2026-09-26T07:59:59.000Z"), asOf: now, loanStartDate: START })).toBeNull()
    // 01:00 SAST; the form's "today" parses to 02:00 SAST.
    expect(rejectImpossibleValueDate({
      receivedAt: at("2026-09-26T00:00:00.000Z"), asOf: at("2026-09-25T23:00:00.000Z"), loanStartDate: START,
    })).toBeNull()
  })

  it("refuses a date before the loan was disbursed", () => {
    expect(rejectImpossibleValueDate({
      receivedAt: at("2026-03-01T00:00:00.000Z"),
      asOf: at("2026-03-10T09:00:00.000Z"), loanStartDate: START,
    })).toBe("before_loan_start")
  })

  // Identical arithmetic to the case above (elapsed days clamp at 0) but
  // legitimate: a repayment on the day of disbursement. The rebate bound, not
  // this one, is what stops a months-old loan being priced at day zero.
  it("allows the disbursement day itself", () => {
    expect(rejectImpossibleValueDate({
      receivedAt: at("2026-03-02T00:00:00.000Z"), asOf: at("2026-03-02T23:00:00.000Z"),
      loanStartDate: START,
    })).toBeNull()
  })

  // 00:30 SAST on 19 Sep is still 18 Sep 21:30 UTC; the form's own default would
  // otherwise be rejected as "future".
  it("accepts today's date when captured after midnight SAST", () => {
    expect(rejectImpossibleValueDate({
      receivedAt: at("2026-09-19T00:00:00.000Z"),
      asOf: at("2026-09-18T22:30:00.000Z"), loanStartDate: START,
    })).toBeNull()
  })
})

describe("rejectUnauthorisedRebate — bounded by what back-dating COSTS", () => {
  // LITERAL amounts, deliberately. Deriving a boundary from the constant is what
  // made the previous window test unable to fail: mutating 14 -> 13 left it
  // green because both sides of the comparison moved together.

  it("allows an ordinary statement-import lag", () => {
    // A 9-day lag on a short-term loan: 30% of the interest, but R30.00 in real
    // money. A fraction-based cap refused this truthful import; this one does not.
    // R30.00 rebated of R100.00 accrued: 30%, well clear of both clauses.
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 3_000, accruedInterestAtCaptureCents: 10_000,
    })).toBeNull()
  })

  it("allows exactly the cap", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 10_000, accruedInterestAtCaptureCents: 100_000,
    })).toBeNull()
  })

  // The case the day-based window waved through: 14 days back on the 30-day
  // micro loan rebated R116.67 with no override and no second person.
  it("refuses one cent over the cap", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 10_001, accruedInterestAtCaptureCents: 100_000,
    })).toBe("rebate_needs_authorisation")
  })

  it("refuses the 14-day rebate on the flagship product", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 11_667, accruedInterestAtCaptureCents: 25_000,
    })).toBe("rebate_needs_authorisation")
  })

  // A 21-day reconcile lag on a R500 000 facility.
  it("refuses a large rebate on a large loan", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 875_000, accruedInterestAtCaptureCents: 1_250_000,
    })).toBe("rebate_needs_authorisation")
  })

  it("allows a zero or negative rebate outright", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 0, accruedInterestAtCaptureCents: 10_000,
    })).toBeNull()
    expect(rejectUnauthorisedRebate({
      interestRebateCents: -500, accruedInterestAtCaptureCents: 10_000,
    })).toBeNull()
  })

  // A loan whose ENTIRE interest is R100.00: the rand cap alone would permit
  // writing off all of it, which is exactly what pricing at the disbursement
  // day does. The erasure clause is what catches this.
  it("refuses a rebate that erases the interest even at the rand cap", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 10_000, accruedInterestAtCaptureCents: 10_000,
    })).toBe("rebate_needs_authorisation")
  })

  // Pins the cap itself, so moving it is a deliberate act rather than drift.
  it("caps unreviewed write-off at R100.00", () => {
    expect(MAX_UNREVIEWED_REBATE_CENTS).toBe(10_000)
  })
})

describe("rejectUnauthorisedRebate — the reasoned override", () => {
  it("lets a senior user authorise a material rebate", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 25_000, accruedInterestAtCaptureCents: 30_000, override: OVERRIDE,
    })).toBeNull()
  })

  it("refuses a token reason", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 25_000, accruedInterestAtCaptureCents: 30_000,
      override: { ...OVERRIDE, reason: "late" },
    })).toBe("override_reason_too_short")
  })

  it("refuses whitespace padded to length", () => {
    expect(rejectUnauthorisedRebate({
      interestRebateCents: 25_000, accruedInterestAtCaptureCents: 30_000,
      override: { ...OVERRIDE, reason: " ".repeat(40) },
    })).toBe("override_reason_too_short")
  })
})

describe("valueDateEvidence", () => {
  it("records the rebate, the lag, the source and who authorised it", () => {
    expect(valueDateEvidence({
      receivedAt: at("2026-09-04T00:00:00.000Z"), asOf: TODAY,
      source: "STAFF_ASSERTED", interestRebateCents: 50_000, override: OVERRIDE,
    })).toEqual({
      receivedAt: "2026-09-04T00:00:00.000Z",
      capturedAt: TODAY.toISOString(),
      source: "STAFF_ASSERTED",
      daysBackdated: 14,
      interestRebateCents: 50_000,
      override: {
        reason: OVERRIDE.reason,
        approvedById: "admin-1",
        approvedByEmail: "admin@acme-lending.example",
      },
    })
  })

  // The source is audit metadata now, not a trust level — but it must still be
  // recorded, because "a staff member typed this date into a CSV" and "a bank
  // supplied it" read identically once the row is written.
  it("labels a statement-sourced date without implying attestation", () => {
    const e = valueDateEvidence({
      receivedAt: TODAY, asOf: TODAY, source: "BANK_STATEMENT", interestRebateCents: 0,
    })
    expect(e.source).toBe("BANK_STATEMENT")
    expect(e.override).toBeUndefined()
    expect(e.daysBackdated).toBe(0)
  })
})

describe("rejectUnauthorisedBackdating — contractual interest and default charges", () => {
  const override = { reason: "Deposit genuinely reached the account on that date.", approvedById: "u1", approvedByEmail: null }

  it("adds the default charges erased to the contractual rebate", () => {
    expect(rejectUnauthorisedBackdating({
      interest: { rebateCents: 6_000, accruedInterestAtCaptureCents: 100_000 },
      charges: { rebateCents: 6_000, accruedAtCaptureCents: 100_000 },
    })).toBe("rebate_needs_authorisation")
  })

  it("catches a date that erases essentially all the default charges, however small", () => {
    // R80 of R80 charges: under the R100 cap and a small share of contractual
    // interest, but it wipes out the default charges entirely.
    expect(rejectUnauthorisedBackdating({
      interest: { rebateCents: 0, accruedInterestAtCaptureCents: 10_000 },
      charges: { rebateCents: 8_000, accruedAtCaptureCents: 8_000 },
    })).toBe("rebate_needs_authorisation")
    expect(rejectUnauthorisedBackdating({
      interest: { rebateCents: 0, accruedInterestAtCaptureCents: 10_000 },
      charges: { rebateCents: 8_000, accruedAtCaptureCents: 8_000 },
      override,
    })).toBeNull()
  })

  it("lets a small partial rebate stand unreviewed", () => {
    expect(rejectUnauthorisedBackdating({
      interest: { rebateCents: 0, accruedInterestAtCaptureCents: 10_000 },
      charges: { rebateCents: 2_000, accruedAtCaptureCents: 8_000 },
    })).toBeNull()
  })
})
