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

vi.mock("./lease-charges", () => ({ appendExtensionRental: vi.fn(async () => ({ periodNo: 3, dueDate: "2027-03-01" })) }))
vi.mock("@/lib/vat/vat-rate", () => ({ loadRateOn: vi.fn(async () => ({ rate: "0.15", rateTenThousandths: 1500 })) }))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAuditStrict: vi.fn(async () => undefined) }))

describe("runLeaseExtensions: the last rental of an extension (C7)", () => {
  // Last rental due 2027-02-01; notice ends the extension on 2027-03-01; the next rental would fall due 2027-03-01.
  const db = (timing: "ADVANCE" | "ARREARS") => ({
    leaseEndOfTerm: { findMany: vi.fn(async () => [{ loanId: "l1", extensionEndsOn: new Date("2027-03-01T00:00:00Z"), loan: { assetFinanceDeal: { rentalTiming: timing } } }]) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ leaseRental: { findFirstOrThrow: vi.fn(async () => ({ dueDate: new Date("2027-02-01T00:00:00Z") })) } })),
  })
  it("in arrears the rental due on the end date is billed (it pays for the month just ended)", async () => {
    const run: DailyRun = { extensionRentals: 0, expiryNotices: 0, failed: 0 }
    await runLeaseExtensions(db("ARREARS") as never, "t1", "2027-03-01", run)
    expect(run.extensionRentals).toBe(1)
  })
  it("in advance it is not: it would pay for the month after the extension ends", async () => {
    const run: DailyRun = { extensionRentals: 0, expiryNotices: 0, failed: 0 }
    await runLeaseExtensions(db("ADVANCE") as never, "t1", "2027-03-01", run)
    expect(run.extensionRentals).toBe(0)
  })
})
