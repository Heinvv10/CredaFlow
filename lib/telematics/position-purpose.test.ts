import { describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  matters: vi.fn(async () => 0), recoveries: vi.fn(async () => 0), theft: vi.fn(async (): Promise<{ id: string } | null> => null),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { legalMatter: { count: m.matters }, recovery: { count: m.recoveries }, assetTheftReport: { findFirst: m.theft } } }))

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
  it("counts a loan pending write-off as in default (still collectable), not one written off", async () => {
    expect(await positionPurposes("t1", { id: "l1", status: "PENDING_WRITE_OFF" })).toMatchObject({ DEFAULT: true })
    expect(await positionPurposes("t1", { id: "l1", status: "DEFAULTED" })).toMatchObject({ DEFAULT: true })
    expect(await positionPurposes("t1", { id: "l1", status: "WRITTEN_OFF" })).toMatchObject({ DEFAULT: false })
    expect(await positionPurposes("t1", { id: "l1", status: "ACTIVE" })).toEqual(none)
  })

  it("has THEFT with a valid report on a running loan, carrying the report; never on a closed loan", async () => {
    m.theft.mockResolvedValue({ id: "tr-1" })
    expect(await positionPurposes("t1", { id: "l1", status: "ACTIVE" })).toMatchObject({ THEFT: true, theftReportId: "tr-1" })
    m.theft.mockClear()
    expect(await positionPurposes("t1", { id: "l1", status: "COMPLETED" })).toMatchObject({ THEFT: false, theftReportId: null })
    expect(m.theft).not.toHaveBeenCalled()
    m.theft.mockResolvedValue(null)
  })
})
