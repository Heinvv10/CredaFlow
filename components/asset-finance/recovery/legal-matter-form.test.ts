import { describe, expect, it } from "vitest"
import { formatIsoDate } from "@/lib/asset-finance/format"
import {
  correctableSteps, correctedStepIds, emptyStepForm, hintText, recordLabel, recordSelectable, refusalText, stepBody, stepFields, stepFormError, stepKindsFor,
} from "./legal-matter-form"

const step = (id: string, kind: "S129_SENT" | "SUMMONS_ISSUED", correctsStepId: string | null = null) => ({
  id, kind, stepDate: "2026-09-01", note: null, section129RecordId: null, correctsStepId, hasEvidence: false, recordedById: "u-1", createdAt: "2026-09-01T08:00:00.000Z",
})
const form = (over: Partial<ReturnType<typeof emptyStepForm>> = {}) => ({ ...emptyStepForm("2026-10-01", "SUMMONS_ISSUED"), ...over })

describe("stepKindsFor", () => {
  it("offers a section 129 step on an NCA matter only", () => {
    expect(stepKindsFor("NCA")).toContain("S129_SENT")
    expect(stepKindsFor("NON_NCA")).not.toContain("S129_SENT")
    expect(stepKindsFor("NON_NCA")).toContain("LETTER_OF_DEMAND")
  })
})

describe("stepFields", () => {
  it("sends only the fields the chosen kind uses", () => {
    expect(stepFields(form({ note: "  filed  ", section129RecordId: "r-1", location: "yard", closeMatter: true }))).toEqual({
      kind: "SUMMONS_ISSUED", stepDate: "2026-10-01", note: "filed",
    })
  })

  it("names the notice record for a section 129 step and the yard and condition for a recovery", () => {
    expect(stepFields(form({ kind: "S129_SENT", section129RecordId: "r-1" }))).toMatchObject({ section129RecordId: "r-1" })
    expect(stepFields(form({ kind: "ASSET_RECOVERED", location: " Yard 4 ", condition: " Good " }))).toMatchObject({ location: "Yard 4", condition: "Good" })
  })

  it("closes the matter only for a settled or withdrawn step, and names a corrected step", () => {
    expect(stepFields(form({ kind: "SETTLED", closeMatter: true }))).toMatchObject({ closeMatter: "true" })
    expect(stepFields(form({ closeMatter: true })).closeMatter).toBeUndefined()
    expect(stepFields(form({ correctsStepId: "s-1" }))).toMatchObject({ correctsStepId: "s-1" })
  })
})

describe("stepBody", () => {
  it("is plain JSON fields without a file and multipart with the file", () => {
    expect(stepBody(form())).toEqual({ kind: "SUMMONS_ISSUED", stepDate: "2026-10-01" })
    const file = new File(["%PDF-1.4"], "order.pdf", { type: "application/pdf" })
    const data = stepBody(form({ file }))
    expect(data).toBeInstanceOf(FormData)
    expect((data as FormData).get("kind")).toBe("SUMMONS_ISSUED")
    expect(((data as FormData).get("file") as File).name).toBe("order.pdf")
  })
})

describe("stepFormError", () => {
  it("asks for the notice, the recovery details and the date before the round trip", () => {
    expect(stepFormError(form())).toBeNull()
    expect(stepFormError(form({ stepDate: "" }))).toMatch(/date/)
    expect(stepFormError(form({ kind: "S129_SENT" }))).toMatch(/section 129/)
    expect(stepFormError(form({ kind: "ASSET_RECOVERED", location: "Yard 4" }))).toMatch(/condition/)
    expect(stepFormError(form({ kind: "ASSET_RECOVERED", location: "Yard 4", condition: "Good" }))).toBeNull()
  })
})

describe("corrections", () => {
  const steps = [step("a", "S129_SENT"), step("b", "S129_SENT", "a"), step("c", "SUMMONS_ISSUED")]
  it("marks the corrected step and offers only steps nothing corrects", () => {
    expect([...correctedStepIds(steps)]).toEqual(["a"])
    expect(correctableSteps(steps).map((s) => s.id)).toEqual(["b", "c"])
  })
})

describe("section 129 record picker", () => {
  const unused = { id: "r-1", completedOn: "2026-09-01", usedByStepId: null }
  const used = { id: "r-2", completedOn: null, usedByStepId: "s-1" }
  it("greys out a used record unless the step is a correction", () => {
    expect(recordSelectable(unused, "")).toBe(true)
    expect(recordSelectable(used, "")).toBe(false)
    expect(recordSelectable(used, "s-1")).toBe(true)
  })
  it("labels the completion date and a used record", () => {
    expect(recordLabel(unused)).toBe(`Notice completed ${formatIsoDate("2026-09-01")}`)
    expect(recordLabel(used)).toBe("Notice completion date not recorded (already used)")
  })
})

describe("text", () => {
  it("prints the hint's date as the app prints dates", () => {
    expect(hintText({ code: "SUMMONS_FROM", text: "summons may issue from 2026-10-30", date: "2026-10-30" })).toBe(`Summons may issue from ${formatIsoDate("2026-10-30")}`)
    expect(hintText({ code: "SEND_S129", text: "send the section 129 notice" })).toBe("Send the section 129 notice")
  })
  it("shows the route's field messages, else its error verbatim", () => {
    expect(refusalText("Invalid legal step", { stepDate: "The date cannot be in the future" })).toBe("The date cannot be in the future")
    expect(refusalText("The loan already has an open legal matter", {})).toBe("The loan already has an open legal matter")
  })
})
