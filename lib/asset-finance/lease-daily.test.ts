import { describe, expect, it, vi } from "vitest"
import { leaseExpiryDate, runLeaseExtensions, type DailyRun } from "./lease-daily"
import { dueDateInstant } from "./schedule-records"

describe("leaseExpiryDate (C7)", () => {
  it("in arrears the last rental's day; in advance a month after it (clamped to the month's end)", () => {
    expect(leaseExpiryDate(dueDateInstant("2027-05-31"), "ARREARS")).toBe("2027-05-31")
    expect(leaseExpiryDate(dueDateInstant("2027-05-31"), "ADVANCE")).toBe("2027-06-30")
    expect(leaseExpiryDate(dueDateInstant("2027-01-15"), "ADVANCE")).toBe("2027-02-15")
    expect(leaseExpiryDate(dueDateInstant("2027-01-15"), null)).toBe("2027-01-15")
  })
})

describe("runLeaseExtensions (C7)", () => {
  it("keeps billing an extension whose loan was completed by paying its last rental, or fell into default", async () => {
    // A lessee who pays the last rental completes the loan; the next extension rental reopens it (refreshLoan).
    const findMany = vi.fn(async () => [])
    const run: DailyRun = { extensionRentals: 0, expiryNotices: 0, failed: 0 }
    await runLeaseExtensions({ leaseEndOfTerm: { findMany } } as never, "t1", "2027-03-01", run)
    const where = (findMany.mock.calls[0] as unknown as [{ where: { loan: { status: { in: string[] } } } }])[0].where
    expect(where.loan.status.in.sort()).toEqual(["ACTIVE", "COMPLETED", "DEFAULTED"])
  })
})
