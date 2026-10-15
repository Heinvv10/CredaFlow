import { describe, expect, it } from "vitest"
import { attorneyAppointmentRefusal, NCA_ATTORNEY_NEEDS_S129 } from "./legal-matter-gate"
import type { HintStep } from "./legal-matter-hint"

const s129: HintStep = { id: "s1", kind: "S129_SENT", stepDate: "2026-10-01", correctsStepId: null }
const ready = { regime: "NCA" as const, collectionsStage: "SECTION_129_SENT", hasIssuedNotice: true, steps: [s129] }

describe("attorneyAppointmentRefusal", () => {
  it("admits an NCA loan with the stage, the issued notice and an effective s129 step", () => {
    expect(attorneyAppointmentRefusal(ready)).toBeNull()
    expect(attorneyAppointmentRefusal({ ...ready, collectionsStage: "PAYMENT_ARRANGEMENT" })).toBeNull()
  })

  it("refuses an NCA loan missing any one of the three", () => {
    expect(attorneyAppointmentRefusal({ ...ready, steps: [] })).toBe(NCA_ATTORNEY_NEEDS_S129)
    expect(attorneyAppointmentRefusal({ ...ready, hasIssuedNotice: false })).toBe(NCA_ATTORNEY_NEEDS_S129)
    expect(attorneyAppointmentRefusal({ ...ready, collectionsStage: "FORMAL_REMINDER" })).toBe(NCA_ATTORNEY_NEEDS_S129)
    expect(attorneyAppointmentRefusal({ ...ready, collectionsStage: null })).toBe(NCA_ATTORNEY_NEEDS_S129)
  })

  it("does not count a corrected s129 step or any other kind", () => {
    const correction: HintStep = { id: "s2", kind: "LETTER_OF_DEMAND", stepDate: "2026-10-02", correctsStepId: "s1" }
    expect(attorneyAppointmentRefusal({ ...ready, steps: [s129, correction] })).toBe(NCA_ATTORNEY_NEEDS_S129)
    expect(attorneyAppointmentRefusal({ ...ready, steps: [{ ...s129, kind: "LETTER_OF_DEMAND" }] })).toBe(NCA_ATTORNEY_NEEDS_S129)
  })

  it("has no section 129 gate for NON_NCA", () => {
    expect(attorneyAppointmentRefusal({ regime: "NON_NCA", collectionsStage: "NONE", hasIssuedNotice: false, steps: [] })).toBeNull()
  })
})
