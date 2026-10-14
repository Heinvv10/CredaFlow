import { describe, expect, it, vi } from "vitest"

vi.mock("./lease-portal-route", () => ({ clientLeaseRefusal: vi.fn(async () => null) }))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAuditStrict: vi.fn(async () => undefined) }))

import { dbDate } from "./dates"
import { PORTAL_PACE_LIMIT, recordMeterReading } from "./meter-readings"
import { dueDateInstant } from "./schedule-records"

/** A lease of 1 000 h a year whose last reading is 100 h on 2027-01-01. */
function tx() {
  return {
    loan: {
      findFirst: vi.fn(async () => ({
        assetId: "a1", status: "ACTIVE", startDate: dueDateInstant("2026-12-01"), assetFinanceDeal: { id: "d1", usageUnit: "HOURS", usageAllowancePerYear: 1_000 },
      })),
    },
    assetMeterReading: {
      findFirst: vi.fn(async (args: { where: { readingDate: { lte?: Date } } }) => (args.where.readingDate.lte ? { value: 100, readingDate: dbDate("2027-01-01") } : null)),
      create: vi.fn(async () => ({ id: "r1" })),
    },
    entityDocument: { findFirst: vi.fn(async () => null) },
  }
}
const record = (value: number, actor: { clientId: string } | { userId: string }) =>
  recordMeterReading(tx() as never, { tenantId: "t1", ...actor } as never, { loanId: "l1", readingDate: "2027-03-01", value, evidenceDocumentId: null, today: "2027-03-01" })

describe("recordMeterReading: the portal's pace limit (C6)", () => {
  it(`a lessee's reading may run ${PORTAL_PACE_LIMIT}× the contracted pace since the last reading, plus a month: at the ceiling admitted, one over refused`, async () => {
    // 59 days since 2027-01-01: 100 + ceil(1 000 × 3 × (59 + 31) / 365) = 100 + ceil(739.73) = 840.
    expect(PORTAL_PACE_LIMIT).toBe(3)
    expect(await record(840, { clientId: "c1" })).toEqual({ kind: "recorded", readingId: "r1" })
    expect(await record(841, { clientId: "c1" })).toMatchObject({ kind: "refused", reason: "implausible_reading" })
  })
  it("staff record a larger reading (with evidence, outside this cap)", async () => {
    expect(await record(10_000, { userId: "u1" })).toEqual({ kind: "recorded", readingId: "r1" })
  })
  it("never below an earlier reading", async () => {
    expect(await record(99, { userId: "u1" })).toMatchObject({ kind: "refused", reason: "not_monotonic" })
  })
})
