import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { normaliseCaseNumber, parseTheftReport } from "./theft-reports"

// The theft report's input rules (docs/asset-finance/SLICE5-FOLLOWUPS.md part
// T). The database holds the same (AssetTheftReport_case_number,
// guardAssetTheftReport): lib/telematics/theft-trail.integration.test.ts.
describe("normaliseCaseNumber", () => {
  it("reads SAPS's CAS <number>/<month>/<year>, however spaced or cased, into one form", () => {
    expect(normaliseCaseNumber("CAS 123/10/2026")).toBe("CAS 123/10/2026")
    expect(normaliseCaseNumber(" cas123 / 09 / 2026 ")).toBe("CAS 123/9/2026")
    expect(normaliseCaseNumber("CAS 999999/12/2025")).toBe("CAS 999999/12/2025")
  })
  it("refuses anything else", () => {
    for (const v of ["123/10/2026", "CAS 0/10/2026", "CAS 1234567/10/2026", "CAS 12/13/2026", "CAS 12/0/2026", "CAS 12/10/26", "OB 12/10/2026", "", null, 12]) {
      expect(normaliseCaseNumber(v)).toBeNull()
    }
  })
})

describe("parseTheftReport", () => {
  const today = "2026-10-22"
  it("takes a case number, a date reported no later than today, and an optional report it renews", () => {
    expect(parseTheftReport({ sapsCaseNumber: "cas 7/10/2026", reportedOn: today }, today)).toEqual({ data: { sapsCaseNumber: "CAS 7/10/2026", reportedOn: today, renewsReportId: null } })
    // A renewal's date is the renewed report's (recordTheftReport reads it): any date sent is ignored here, even one too old.
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: "2026-01-01", renewsReportId: "tr_1" }, today))
      .toEqual({ data: { sapsCaseNumber: "CAS 7/10/2026", reportedOn: today, renewsReportId: "tr_1" } })
  })
  it("refuses a first report dated more than 14 days back, and takes one dated exactly 14 days back", () => {
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: "2026-10-07" }, today)).toEqual({ errors: { reportedOn: "A theft is recorded within 14 days of its report to SAPS" } })
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: "2026-10-08" }, today)).toMatchObject({ data: { reportedOn: "2026-10-08" } })
  })
  it("names each wrong field: a malformed case, a case of a later year, a date in the future or not a date, a renewal that is not an id", () => {
    expect(parseTheftReport({ sapsCaseNumber: "7/10/2026", reportedOn: today }, today)).toEqual({ errors: { sapsCaseNumber: expect.stringContaining("CAS") } })
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/1/2027", reportedOn: today }, today)).toEqual({ errors: { sapsCaseNumber: "The case's year is not after this year" } })
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: "2026-10-23" }, today)).toEqual({ errors: { reportedOn: "The date the theft was reported is not in the future" } })
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: "22/10/2026" }, today)).toEqual({ errors: { reportedOn: expect.stringContaining("yyyy-mm-dd") } })
    expect(parseTheftReport({ sapsCaseNumber: "CAS 7/10/2026", reportedOn: today, renewsReportId: 5 }, today)).toEqual({ errors: { renewsReportId: "The report this renews" } })
    expect(parseTheftReport(null, today)).toMatchObject({ errors: { sapsCaseNumber: expect.any(String), reportedOn: expect.any(String) } })
  })
})
