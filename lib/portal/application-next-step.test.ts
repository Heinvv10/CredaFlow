import { describe, expect, it } from "vitest"
import { portalApplicationNextStep } from "./application-next-step"

// The ceremony window: APPROVED, quotation issued, no agreement yet. NCA
// s.92(1) attaches the quotation to entering into the agreement, not to the
// credit decision, so this — not UNDER_REVIEW — is when the consumer is asked
// to acknowledge it.
const base = {
  status: "APPROVED",
  agreementGeneratedAt: null as Date | null,
  pasqDocumentId: "doc-1",
  pasqDocumentSha256: "a".repeat(64),
  pasqAcknowledgedAt: null as Date | null,
  pasqAcknowledgedSha256: null as string | null,
}

describe("portalApplicationNextStep", () => {
  it("demands the PASQ acknowledgement while one is on screen unacknowledged", () => {
    // Regression: this exact state rendered "No action is required from you
    // right now" and "Action required: review your PASQ" simultaneously.
    expect(portalApplicationNextStep(base)).toBe("pasq_acknowledgement")
  })

  it("stops demanding it once the exact PASQ is acknowledged", () => {
    expect(portalApplicationNextStep({
      ...base,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00Z"),
      pasqAcknowledgedSha256: base.pasqDocumentSha256,
    })).toBe("none")
  })

  it("still demands acknowledgement when a STALE acknowledgement covers a different PASQ", () => {
    expect(portalApplicationNextStep({
      ...base,
      pasqAcknowledgedAt: new Date("2026-07-28T10:00:00Z"),
      pasqAcknowledgedSha256: "b".repeat(64),
    })).toBe("pasq_acknowledgement")
  })

  it("stops demanding it once the agreement has been generated", () => {
    // The quotation has been used at that point; asking the consumer to act on
    // it again would be asking them to re-do a step that already bound.
    expect(portalApplicationNextStep({
      ...base,
      agreementGeneratedAt: new Date("2026-07-28T11:00:00Z"),
    })).toBe("none")
  })

  it("shows review-wait for SUBMITTED and UNDER_REVIEW", () => {
    for (const status of ["SUBMITTED", "UNDER_REVIEW"]) {
      expect(portalApplicationNextStep({
        ...base,
        status,
        pasqDocumentId: null,
        pasqDocumentSha256: null,
      })).toBe("review_wait")
    }
  })

  it("never demands acknowledgement before approval", () => {
    // A quotation cannot legitimately exist here any more, but if one lingered
    // the portal must not present it as the consumer's next step.
    expect(portalApplicationNextStep({ ...base, status: "UNDER_REVIEW" })).toBe("review_wait")
  })

  it("shows nothing for terminal or pre-submission statuses", () => {
    for (const status of ["DRAFT", "DECLINED", "DISBURSED", "CANCELLED"]) {
      expect(portalApplicationNextStep({ ...base, status })).toBe("none")
    }
  })
})
