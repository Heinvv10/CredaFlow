import { describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  theft: vi.fn(async (_args: { where: Record<string, unknown> }): Promise<{ id: string } | null> => null),
  holds: vi.fn(async (_sql: unknown): Promise<Array<Record<string, boolean>>> => [{ DEFAULT: false, RECOVERY: false, LEGAL_MATTER: false, THEFT: false }]),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { assetTheftReport: { findFirst: m.theft }, $queryRaw: m.holds } }))

import { PURPOSE_REFUSAL, positionPurposes, purposeRefusal } from "./position-purpose"

// The reveal and the panels share one purpose gate (SLICE5.md part B, Deviation 3).
const none = { DEFAULT: false, RECOVERY: false, LEGAL_MATTER: false, THEFT: false, theftReportId: null }

describe("the position purpose gate", () => {
  it("refuses every context with no purpose, and a context the loan does not have", () => {
    for (const context of ["DEFAULT", "RECOVERY", "LEGAL_MATTER", "THEFT"] as const) {
      expect(purposeRefusal(none, context)).toEqual({ reason: "no_purpose", error: PURPOSE_REFUSAL })
    }
    expect(purposeRefusal({ ...none, LEGAL_MATTER: true }, "RECOVERY")).toEqual({ reason: "no_recovery", error: "This loan has no open recovery" })
    expect(purposeRefusal({ ...none, RECOVERY: true }, "DEFAULT")).toEqual({ reason: "no_default", error: "This loan is not in default" })
    expect(purposeRefusal({ ...none, DEFAULT: true }, "LEGAL_MATTER")).toEqual({ reason: "no_legal_matter", error: "This loan has no open legal matter" })
    expect(purposeRefusal({ ...none, DEFAULT: true }, "THEFT")).toEqual({ reason: "no_theft", error: "This loan has no theft report valid today" })
  })

  it("answers a context the loan has", () => {
    expect(purposeRefusal({ ...none, DEFAULT: true }, "DEFAULT")).toBeNull()
    expect(purposeRefusal({ ...none, RECOVERY: true }, "RECOVERY")).toBeNull()
    expect(purposeRefusal({ ...none, LEGAL_MATTER: true }, "LEGAL_MATTER")).toBeNull()
    expect(purposeRefusal({ ...none, THEFT: true, theftReportId: "tr-1" }, "THEFT")).toBeNull()
  })
})

describe("the loan's purposes", () => {
  // The rule itself is the database's ("telematicsPurposeHolds"), proven on real Postgres in theft-trail.integration.test.ts.
  it("asks the database for each context and passes its answer on", async () => {
    m.holds.mockResolvedValueOnce([{ DEFAULT: true, RECOVERY: false, LEGAL_MATTER: true, THEFT: false }])
    expect(await positionPurposes("t1", { id: "l1", status: "DEFAULTED" })).toEqual({ ...none, DEFAULT: true, LEGAL_MATTER: true })
    const sql = m.holds.mock.calls.at(-1)?.[0] as { strings: string[]; values: unknown[] }
    expect(sql.strings.join("?")).toMatch(/"telematicsPurposeHolds"/)
    expect(sql.values).toEqual(["t1", "l1", "t1", "l1", "t1", "l1", "t1", "l1", null])
  })

  it("names only a confirmed, open, valid report for THEFT, and only when the database says THEFT holds", async () => {
    m.theft.mockResolvedValue({ id: "tr-1" })
    m.holds.mockResolvedValueOnce([{ DEFAULT: false, RECOVERY: false, LEGAL_MATTER: false, THEFT: true }])
    expect(await positionPurposes("t1", { id: "l1", status: "ACTIVE" })).toMatchObject({ THEFT: true, theftReportId: "tr-1" })
    expect(m.theft.mock.calls.at(-1)?.[0].where).toMatchObject({ confirmedAt: { not: null }, endedAt: null })
    m.holds.mockResolvedValueOnce([{ DEFAULT: false, RECOVERY: false, LEGAL_MATTER: false, THEFT: false }])
    expect(await positionPurposes("t1", { id: "l1", status: "COMPLETED" })).toMatchObject({ THEFT: false, theftReportId: null })
    m.theft.mockResolvedValue(null)
  })
})
