import { describe, expect, it } from "vitest"
import { leaseExpiryDate } from "./lease-daily"
import { dueDateInstant } from "./schedule-records"

describe("leaseExpiryDate (C7)", () => {
  it("in arrears the last rental's day; in advance a month after it (clamped to the month's end)", () => {
    expect(leaseExpiryDate(dueDateInstant("2027-05-31"), "ARREARS")).toBe("2027-05-31")
    expect(leaseExpiryDate(dueDateInstant("2027-05-31"), "ADVANCE")).toBe("2027-06-30")
    expect(leaseExpiryDate(dueDateInstant("2027-01-15"), "ADVANCE")).toBe("2027-02-15")
    expect(leaseExpiryDate(dueDateInstant("2027-01-15"), null)).toBe("2027-01-15")
  })
})
