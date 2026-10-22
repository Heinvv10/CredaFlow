import { beforeEach, describe, expect, it, vi } from "vitest"

const { logAuditStrict } = vi.hoisted(() => ({ logAuditStrict: vi.fn(async () => undefined) }))
vi.mock("./lease-portal-route", () => ({ clientLeaseRefusal: vi.fn(async () => null) }))
vi.mock("@/lib/audit", async (original) => ({ ...(await original<typeof import("@/lib/audit")>()), logAuditStrict }))

import { dbDate } from "./dates"
import { recordMeterReading } from "./meter-readings"
import { dueDateInstant } from "./schedule-records"

// The tracker arm of recordMeterReading (docs/asset-finance/SLICE5.md part B):
// the same lease as meter-readings.test.ts (1 000 h a year, start reading 50 h
// on 2026-12-01, last reading 100 h on 2027-01-01). Ceiling on 2027-03-01: 1 045.
function tx(status = "ACTIVE") {
  return {
    loan: {
      findFirst: vi.fn(async () => ({
        assetId: "a1", status, startDate: dueDateInstant("2026-12-01"), assetFinanceDeal: { id: "d1", usageUnit: "HOURS", usageAllowancePerYear: 1_000 },
      })),
    },
    assetMeterReading: {
      findFirst: vi.fn(async (args: { where: { readingDate?: { lte?: Date } } }) => {
        if (!args.where.readingDate) return { value: 50, readingDate: dbDate("2026-12-01") }
        return args.where.readingDate.lte ? { value: 100, readingDate: dbDate("2027-01-01") } : { value: 2_000 }
      }),
      create: vi.fn(async () => ({ id: "r1" })),
    },
    entityDocument: { findFirst: vi.fn(async () => null) },
  }
}
const telematics = (eventId: string, acceptedById?: string) => ({ tenantId: "t1", telematics: { eventId, ...(acceptedById ? { acceptedById } : {}) } })
const input = (value: number) => ({ loanId: "l1", readingDate: "2027-03-01", value, evidenceDocumentId: null, today: "2027-03-01" })

describe("recordMeterReading: a tracker's reading", () => {
  beforeEach(() => logAuditStrict.mockClear())

  it("is written as TELEMATICS, bound to its event, unattended, and audited as the system", async () => {
    const db = tx()
    expect(await recordMeterReading(db as never, telematics("ev1"), input(1_045))).toEqual({ kind: "recorded", readingId: "r1" })
    expect(db.assetMeterReading.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ source: "TELEMATICS", telematicsEventId: "ev1", recordedById: null, recordedByClientId: null, evidenceDocumentId: null }),
    }))
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      userId: undefined, action: "METER_READING_RECORDED",
      newValue: expect.objectContaining({ source: "TELEMATICS", actor: { type: "system", source: "telematics", eventId: "ev1" } }),
    }), db)
  })

  it("keeps within the portal's pace ceiling unattended; a staff acceptance vouches for it and is not capped", async () => {
    expect(await recordMeterReading(tx() as never, telematics("ev1"), input(1_046))).toMatchObject({ kind: "refused", reason: "implausible_reading" })
    const db = tx()
    expect(await recordMeterReading(db as never, telematics("ev1", "u9"), input(1_046))).toEqual({ kind: "recorded", readingId: "r1" })
    expect(db.assetMeterReading.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recordedById: "u9", source: "TELEMATICS" }) }))
    expect(logAuditStrict).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "u9" }), db)
  })

  it("says which bound a monotonic refusal broke", async () => {
    expect(await recordMeterReading(tx() as never, telematics("ev1"), input(99))).toMatchObject({ kind: "refused", reason: "not_monotonic", bound: "earlier" })
    expect(await recordMeterReading(tx() as never, telematics("ev1", "u9"), input(2_001))).toMatchObject({ kind: "refused", reason: "not_monotonic", bound: "later" })
  })

  it("is written only on a running lease", async () => {
    for (const status of ["COMPLETED", "CANCELLED", "WRITTEN_OFF"]) {
      expect(await recordMeterReading(tx(status) as never, telematics("ev1"), input(500))).toMatchObject({ kind: "refused", reason: "lease_closed" })
    }
    expect(await recordMeterReading(tx("DEFAULTED") as never, telematics("ev1"), input(500))).toMatchObject({ kind: "recorded" })
  })
})
