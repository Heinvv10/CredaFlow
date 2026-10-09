import { describe, expect, it } from "vitest"
import type { CompositeKycResult } from "@/lib/kyc/document-state"
import { deriveKycBlockers, kycGateStage, summariseGaps } from "@/lib/kyc/kyc-blockers"

/**
 * Fixtures state `ok` explicitly rather than calling deriveCompositeKycState,
 * so the expectation and the code under test come from genuinely different
 * sources. If deriveKycBlockers drifts from CompositeKycResult's own rule,
 * these disagree instead of moving together.
 */
function gate(over: Partial<CompositeKycResult>): CompositeKycResult {
  return {
    ok: true,
    okForOrigination: true,
    coreDocumentGaps: [],
    biometricAttemptFailed: false,
    state: {
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments: [],
    biometricEvidence: null,
    manualRejectionActive: false,
    manualExceptionActive: false,
    manualException: null,
    ...over,
  } as CompositeKycResult
}

describe("kycGateStage", () => {
  it("covers every status whose transition the API gates on composite KYC", () => {
    // APPROVED is the disbursement gate: disburse/route.ts re-derives composite
    // KYC and 422s with disbursementPrecondition "composite_kyc". Omitting it
    // lets the rail read "No blockers" over a payout the API will refuse.
    expect(kycGateStage("SUBMITTED")).toBe("review")
    expect(kycGateStage("UNDER_REVIEW")).toBe("approval")
    expect(kycGateStage("APPROVED")).toBe("disbursement")
  })

  it("returns null for statuses with no composite KYC gate ahead of them", () => {
    for (const status of ["DRAFT", "DECLINED", "CANCELLED", "DISBURSED"]) {
      expect(kycGateStage(status)).toBeNull()
    }
  })
})

describe("deriveKycBlockers", () => {
  const cases: Array<{
    name: string
    gate: CompositeKycResult
    ok: boolean
    okForOrigination: boolean
  }> = [
    { name: "clean", gate: gate({ ok: true }), ok: true, okForOrigination: true },
    {
      name: "missing core documents",
      gate: gate({ ok: false, okForOrigination: false, missingCoreDocuments: ["ID_COPY", "PROOF_OF_ADDRESS"] }),
      ok: false,
      okForOrigination: false,
    },
    {
      // A capture that failed blocks origination as well as payout.
      name: "biometric failure",
      gate: gate({ ok: false, okForOrigination: false, biometricAttemptFailed: true, biometricEvidence: "face_not_detected" }),
      ok: false,
      okForOrigination: false,
    },
    {
      // Never captured: payout blocked, origination allowed (policy 2026-07-27).
      name: "no selfie captured yet",
      gate: gate({ ok: false, okForOrigination: true, biometricEvidence: "biometric_evidence_missing" }),
      ok: false,
      okForOrigination: true,
    },
    {
      name: "biometric failure covered by an approved manual exception",
      gate: gate({ ok: true, biometricEvidence: "face_not_detected", manualExceptionActive: true }),
      ok: true,
      okForOrigination: true,
    },
    {
      name: "manual rejection",
      gate: gate({ ok: false, okForOrigination: false, manualRejectionActive: true }),
      ok: false,
      okForOrigination: false,
    },
    {
      name: "manual rejection while the latest selfie also fails",
      gate: gate({ ok: false, okForOrigination: false, manualRejectionActive: true, biometricEvidence: "vlm_liveness_failed" }),
      ok: false,
      okForOrigination: false,
    },
    {
      name: "manual exception cannot rescue missing documents",
      gate: gate({
        ok: false,
        okForOrigination: false,
        missingCoreDocuments: ["BANK_STATEMENT"],
        biometricEvidence: "face_not_detected",
        manualExceptionActive: true,
      }),
      ok: false,
      okForOrigination: false,
    },
  ]

  // The invariant is stage-dependent now: review and approval are gated on
  // okForOrigination, the signing/payout stage on the strict ok.
  it.each(cases)("$name: blocks review exactly when origination is closed", ({ gate: g, okForOrigination }) => {
    expect(deriveKycBlockers(g, "review").length > 0).toBe(!okForOrigination)
    expect(deriveKycBlockers(g, "approval").length > 0).toBe(!okForOrigination)
  })

  it.each(cases)("$name: blocks disbursement exactly when the strict gate is closed", ({ gate: g, ok }) => {
    expect(deriveKycBlockers(g, "disbursement").length > 0).toBe(!ok)
  })

  it("returns nothing when no gate stands ahead of the application", () => {
    expect(deriveKycBlockers(null, "review")).toEqual([])
  })

  it("names the stage the gate actually blocks", () => {
    const blockers = deriveKycBlockers(
      gate({ ok: false, okForOrigination: false, missingCoreDocuments: ["ID_COPY"] }),
      "disbursement",
    )
    expect(blockers[0].detail).toContain("disbursement")
    expect(blockers[0].detail).not.toContain("review")
  })

  it("does not tell the user to re-capture a selfie that was never taken", () => {
    // Relaxing origination made this state reachable at the payout stage:
    // approved with no capture at all. "Re-capture it" names an action that
    // cannot be performed and omits the in-person route entirely.
    const blockers = deriveKycBlockers(
      gate({ ok: false, okForOrigination: true, biometricEvidence: "biometric_evidence_missing" }),
      "disbursement",
    )

    expect(blockers).toHaveLength(1)
    expect(blockers[0].detail).not.toMatch(/re-capture/i)
    expect(blockers[0].detail).toMatch(/in-person verification/i)
  })

  it("does tell the user to re-capture a selfie that failed", () => {
    const blockers = deriveKycBlockers(
      gate({ ok: false, okForOrigination: false, biometricAttemptFailed: true, biometricEvidence: "vlm_liveness_failed" }),
      "disbursement",
    )

    expect(blockers).toHaveLength(1)
    expect(blockers[0].detail).toMatch(/re-capture/i)
  })

  it("does not tell the user to re-capture a selfie while a manual rejection stands", () => {
    // review/route.ts returns on manual rejection before reading biometric
    // state, so a stale biometric failure is not the operative gate here and
    // acting on it would waste the client's time.
    const blockers = deriveKycBlockers(
      gate({ ok: false, okForOrigination: false, manualRejectionActive: true, biometricEvidence: "vlm_liveness_failed" }),
      "review",
    )
    expect(blockers).toHaveLength(1)
    expect(blockers[0].label).toBe("KYC manually rejected")
    expect(blockers.some((b) => /selfie/i.test(b.detail))).toBe(false)
  })

  it("drops the biometric blocker an approved exception covers, keeping the rest", () => {
    const blockers = deriveKycBlockers(
      gate({
        ok: false,
        okForOrigination: false,
        missingCoreDocuments: ["BANK_STATEMENT"],
        biometricEvidence: "face_not_detected",
        manualExceptionActive: true,
      }),
      "approval",
    )
    expect(blockers.map((b) => b.label)).toEqual(["1 KYC document outstanding"])
  })

  it("pluralises the outstanding-document count", () => {
    expect(
      deriveKycBlockers(gate({ ok: false, okForOrigination: false, missingCoreDocuments: ["ID_COPY"] }), "review")[0].label,
    ).toBe("1 KYC document outstanding")
    expect(
      deriveKycBlockers(
        gate({ ok: false, okForOrigination: false, missingCoreDocuments: ["ID_COPY", "BANK_STATEMENT"] }),
        "review",
      )[0].label,
    ).toBe("2 KYC documents outstanding")
  })
})

describe("outstanding document copy", () => {
  it("distinguishes the three states, because each needs a different action", () => {
    const text = summariseGaps([
      { docType: "PAYSLIP", state: "not_uploaded" },
      { docType: "BANK_STATEMENT", state: "flagged" },
      { docType: "PROOF_OF_ADDRESS", state: "awaiting_verification" },
    ])

    expect(text).toContain("Not uploaded: Payslip.")
    expect(text).toContain("Flagged, read the note: Bank Statement.")
    expect(text).toContain("Awaiting verification: Proof of Address.")
  })

  it("does not call an uploaded document missing", () => {
    // The defect this replaces: staff read "missing" against a document
    // already on file and go looking for an upload that is right there.
    const text = summariseGaps([{ docType: "BANK_STATEMENT", state: "flagged" }])
    expect(text).not.toMatch(/missing/i)
    expect(text).not.toMatch(/not uploaded/i)
  })

  it("omits states that have no documents rather than printing empty headings", () => {
    expect(summariseGaps([{ docType: "PAYSLIP", state: "not_uploaded" }]))
      .toBe("Not uploaded: Payslip.")
    expect(summariseGaps([])).toBe("")
  })

  it("tells the user to complete AND verify, not merely to verify", () => {
    const blockers = deriveKycBlockers(
      gate({
        ok: false,
        okForOrigination: false,
        missingCoreDocuments: ["PAYSLIP"],
        coreDocumentGaps: [{ docType: "PAYSLIP", state: "not_uploaded" }],
      }),
      "review",
    )

    expect(blockers[0].label).toBe("1 KYC document outstanding")
    expect(blockers[0].detail).toContain("completed and verified")
    expect(blockers[0].detail).toContain("Not uploaded: Payslip.")
  })
})
