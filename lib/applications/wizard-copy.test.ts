import { describe, expect, it } from "vitest"
import { AFFORDABILITY_FAIL_REVIEW_COPY, AFFORDABILITY_FAIL_REVIEW_RECONFIRM, PASQ_TIMING_COPY } from "./wizard-copy"
import { validateStep3Affordability } from "@/lib/validation/application-wizard"
import { EMPTY_APPLICATION_WIZARD_DATA } from "@/components/applications/wizard/types"

describe("new-application wizard copy", () => {
  // Fair Score audit 2026-10-16: the copy said the PASQ is acknowledged before
  // approval; the flow issues it only after approval.
  it("places the PASQ after approval, with the agreement", () => {
    expect(PASQ_TIMING_COPY).toContain("once the application is approved")
    expect(PASQ_TIMING_COPY).not.toContain("before approval")
  })

  it("sends a failed affordability for a decline/override review instead of 'proceeding'", () => {
    for (const copy of [AFFORDABILITY_FAIL_REVIEW_COPY, AFFORDABILITY_FAIL_REVIEW_RECONFIRM]) {
      expect(copy).toContain("decline/override review")
      expect(copy).not.toMatch(/proceeding would constitute reckless lending/)
    }
    expect(validateStep3Affordability({ ...EMPTY_APPLICATION_WIZARD_DATA, affordabilityFlag: "FAIL", recklessLendingConfirmed: false }).recklessLendingConfirmed)
      .toBe("Confirm the application goes for a decline/override review to proceed")
  })
})
