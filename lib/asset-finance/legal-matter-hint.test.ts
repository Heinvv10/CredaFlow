import { describe, expect, it } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { effectiveSteps, nextLegalStepHint, type HintStep, type LegalStepKind } from "./legal-matter-hint"

let n = 0
const step = (kind: LegalStepKind, stepDate = "2026-03-02", correctsStepId: string | null = null): HintStep => ({ id: `s${++n}`, kind, stepDate, correctsStepId })

describe("nextLegalStepHint", () => {
  it("asks an NCA matter for the section 129 notice first", () => {
    expect(nextLegalStepHint("NCA", [])?.code).toBe("SEND_S129")
    expect(nextLegalStepHint("NCA", [step("LETTER_OF_DEMAND")])?.code).toBe("SEND_S129")
  })

  it("dates the NCA summons 10 SA business days after the earliest section 129 notice", () => {
    const hint = nextLegalStepHint("NCA", [step("S129_SENT", "2026-03-09"), step("S129_SENT", "2026-03-02")])
    expect(hint).toEqual({ code: "SUMMONS_FROM", text: "summons may issue from 2026-03-16", date: "2026-03-16" })
  })

  it("skips weekends and public holidays (Good Friday and Family Day 2026)", () => {
    const hint = nextLegalStepHint("NCA", [step("S129_SENT", "2026-03-20")])
    expect(hint?.date).toBe("2026-04-07")
  })

  it("lets a NON_NCA summons issue from the letter of demand's date", () => {
    expect(nextLegalStepHint("NON_NCA", [])?.code).toBe("SEND_DEMAND")
    expect(nextLegalStepHint("NON_NCA", [step("LETTER_OF_DEMAND", "2026-03-05")])).toEqual({
      code: "SUMMONS_FROM", text: "summons may issue from 2026-03-05", date: "2026-03-05",
    })
  })

  it("follows the court sequence", () => {
    const base = [step("S129_SENT")]
    expect(nextLegalStepHint("NCA", [...base, step("SUMMONS_ISSUED")])?.code).toBe("SERVE_SUMMONS")
    expect(nextLegalStepHint("NCA", [...base, step("SUMMONS_ISSUED"), step("SUMMONS_SERVED")])?.code).toBe("APPLY_JUDGMENT")
    expect(nextLegalStepHint("NCA", [...base, step("JUDGMENT")])?.code).toBe("APPLY_ATTACHMENT")
    expect(nextLegalStepHint("NCA", [...base, step("JUDGMENT"), step("ATTACHMENT_ORDER")])?.code).toBe("RECOVER_ASSET")
    expect(nextLegalStepHint("NCA", [...base, step("JUDGMENT"), step("ATTACHMENT_ORDER"), step("ASSET_RECOVERED")])?.code).toBe("CONTINUE_RECOVERY")
  })

  it("has nothing to say once settled or withdrawn", () => {
    expect(nextLegalStepHint("NCA", [step("S129_SENT"), step("SETTLED")])).toBeNull()
    expect(nextLegalStepHint("NON_NCA", [step("WITHDRAWN")])).toBeNull()
  })

  it("ignores a corrected step", () => {
    const wrong = step("S129_SENT", "2026-03-02")
    const right = step("S129_SENT", "2026-03-04", wrong.id)
    expect(effectiveSteps([wrong, right])).toEqual([right])
    expect(nextLegalStepHint("NCA", [wrong, right])?.date).toBe(addSouthAfricanBusinessDays("2026-03-04", 10))
    const mistakenSummons = step("SUMMONS_ISSUED")
    const retraction = step("LETTER_OF_DEMAND", "2026-03-03", mistakenSummons.id)
    expect(nextLegalStepHint("NON_NCA", [mistakenSummons, retraction])?.code).toBe("SUMMONS_FROM")
  })
})
