import { describe, expect, it } from "vitest"
import { buildApplicationTimeline, portalApplicationStatus, type TimelineApplication } from "./application-view"

const base: TimelineApplication = {
  status: "SUBMITTED", createdAt: new Date("2026-10-16T08:00:00Z"), updatedAt: new Date("2026-10-16T08:00:00Z"),
  submittedAt: new Date("2026-10-16T08:00:00Z"), incomeVerifiedAt: null, pasqGeneratedAt: null, pasqAcknowledgedAt: null,
  pasqAcknowledgedSha256: null, pasqDocumentSha256: null, approvedAt: null, declineCategory: null,
  agreementGeneratedAt: null, agreementSignedAt: null, debitMandatePreparedAt: null, debitMandateSignedAt: null, disbursedAt: null,
}

describe("portalApplicationStatus", () => {
  it("shows a disbursed application whose loan is paid up as Settled (Thembeka)", () => {
    expect(portalApplicationStatus("DISBURSED", "COMPLETED")).toBe("SETTLED")
    expect(portalApplicationStatus("DISBURSED", "ACTIVE")).toBe("DISBURSED")
    expect(portalApplicationStatus("DECLINED", null)).toBe("DECLINED")
  })
})

describe("buildApplicationTimeline", () => {
  // Lerato, Fair Score audit 2026-10-16: declined, and the later write moved
  // updatedAt past the decision, so "Under review" sorted after "declined".
  it("puts Under review before the decline even when updatedAt is later", () => {
    const labels = buildApplicationTimeline({
      ...base, status: "DECLINED", declineCategory: "BUREAU_SCORE",
      approvedAt: new Date("2026-10-16T09:00:00Z"), updatedAt: new Date("2026-10-16T09:05:00Z"),
    }).map((e) => e.label)
    expect(labels).toEqual(["tlSubmitted", "tlUnderReview", "tlDeclined"])
  })

  it("keeps Under review ahead when it ties with the decision", () => {
    const at = new Date("2026-10-16T09:00:00Z")
    const labels = buildApplicationTimeline({ ...base, status: "DECLINED", declineCategory: "AFFORDABILITY", approvedAt: at, updatedAt: at })
      .map((e) => e.label)
    expect(labels).toEqual(["tlSubmitted", "tlUnderReview", "tlDeclined"])
  })
})
