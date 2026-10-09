import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { computeReadiness, type ReadinessInput } from "@/lib/applications/readiness"
import { readinessReadyLabel, readinessSummary } from "@/lib/applications/readiness-view"
import type { CompositeKycResult } from "@/lib/kyc/document-state"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  SUBMISSION_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityCalculatorEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  type AffordabilityDecisionInputs,
} from "@/lib/affordability/snapshot"
import { calculateLoan } from "@/lib/loan-calculator"
import { CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import {
  providerCountersignatureEnvelopeSha256,
  providerCountersignatureSha256,
} from "@/lib/compliance/provider-countersign"
import {
  bureauCheck as evidenceBureauCheck,
  disbursementApplicationFixture,
  tenantConfig as evidenceTenantConfig,
} from "@/lib/affordability/__fixtures__/approval-evidence"

const TENANT_ID = "tenant-1"
const APPLICATION_ID = "app-1"
const CLIENT_ID = "client-1"
const PRINCIPAL = 600_000
const TERM_DAYS = 90
const SUBMITTED_AT = new Date("2026-08-01T09:00:00.000Z")
const SIGNED_AT = new Date("2026-08-03T09:00:00.000Z")
const COUNTERSIGNED_AT = new Date("2026-08-03T10:00:00.000Z")
const GENERATED_AT = new Date("2026-08-02T09:00:00.000Z")
const AGREEMENT_SHA = createHash("sha256").update("agreement-bytes").digest("hex")

function okKyc(overrides: Partial<CompositeKycResult> = {}): CompositeKycResult {
  return {
    ok: true,
    state: {
      kycStatus: "VERIFIED",
      kycVerifiedAt: SUBMITTED_AT,
      kycVerifiedById: null,
      kycVerificationMethod: "BIOMETRIC",
    },
    missingCoreDocuments: [],
    coreDocumentGaps: [],
    biometricEvidence: null,
    okForOrigination: true,
    biometricAttemptFailed: false,
    manualRejectionActive: false,
    manualExceptionActive: false,
    substituteKind: null,
    manualException: null,
    inPersonVerification: null,
    ...overrides,
  }
}

/** All four core documents on file, but the payslip has never been uploaded. */
function payslipMissingKyc(): CompositeKycResult {
  return okKyc({
    ok: false,
    okForOrigination: false,
    state: {
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments: ["PAYSLIP"],
    coreDocumentGaps: [{ docType: "PAYSLIP", state: "not_uploaded" }],
  })
}

function submissionSnapshot() {
  const startDate = SUBMITTED_AT
  const calculation = calculateLoan(
    {
      principal: PRINCIPAL,
      termDays: TERM_DAYS,
      interestRatePm: 0.03,
      interestModel: "REDUCING_BALANCE",
      initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.05,
      initiationFeeMax: 0,
      monthlyServiceFee: 6_900,
      initiationFeePayment: "DEFERRED",
      productType: "PERSONAL_LOAN",
    },
    startDate,
  )
  const calculatorEvidence = createAffordabilityCalculatorEvidence(calculation, startDate)
  const inputs: AffordabilityDecisionInputs = {
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents: calculatorEvidence.recurringInstalmentCents,
    principalCents: PRINCIPAL,
    termDays: TERM_DAYS,
    productId: "product-1",
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 0.05,
    initiationFeeMaxCents: 0,
    monthlyServiceFeeCents: 6_900,
    productType: "PERSONAL_LOAN",
    initiationFeePayment: "DEFERRED",
    ndiBufferPct: 100,
  }
  const expenseEvidence = createAffordabilityExpenseEvidence({
    grossMonthlyIncome: 2_000_000,
    monthlyIncome: 2_000_000,
    monthlyExpenses: 800_000,
    // Must total statedMonthlyExpensesCents exactly, or the expense evidence
    // is not intact and the whole snapshot reads as altered.
    expenseBreakdown: {
      housing: 300_000,
      transport: 100_000,
      food: 200_000,
      education: 0,
      insurance: 0,
      clothing: 0,
      entertainment: 0,
      medical: 0,
      other: 200_000,
      belowMleJustification: null,
    },
  })
  const ndi = inputs.monthlyIncomeCents - inputs.monthlyExpensesCents
  return createAffordabilitySnapshot({
    stage: "SUBMISSION",
    policyVersion: SUBMISSION_AFFORDABILITY_POLICY_VERSION,
    capturedAt: SUBMITTED_AT,
    capturedById: "officer-1",
    inputs,
    applicationDebts: [],
    clientDebts: [],
    expenseEvidence,
    bureauEvidence: null,
    calculation,
    calculationStartDate: startDate,
    outcome: {
      netDisposableIncomeCents: ndi,
      ndiAfterLoanCents: ndi - inputs.proposedInstalmentCents,
      requiredNdiCents: inputs.proposedInstalmentCents,
      isAffordable: true,
      reason: null,
    },
  })
}

/** A no-offer credit-life disclosure: DECLINED, zero premium, hash intact. */
function creditLifeDisclosure() {
  return {
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      election: "DECLINED",
      principalCents: PRINCIPAL,
      termDays: TERM_DAYS,
    }),
    creditLifeDisclosureAcknowledgedAt: SUBMITTED_AT,
    creditLifeDisclosureAcknowledgedBy: "consumer",
  }
}

/** An intact provider countersignature over an intact consumer signature. */
function countersign() {
  const consumerSignatureData = "consumer-signature"
  const providerSignatureData = "provider-signature"
  const providerSignatureSha256 = providerCountersignatureSha256(providerSignatureData)
  const envelopeSha256 = providerCountersignatureEnvelopeSha256({
    tenantId: TENANT_ID,
    applicationId: APPLICATION_ID,
    clientId: CLIENT_ID,
    documentSha256: AGREEMENT_SHA,
    consumerSignedAt: SIGNED_AT,
    consumerSignedMethod: "portal",
    consumerSignerId: CLIENT_ID,
    consumerSignatureSha256: providerCountersignatureSha256(consumerSignatureData),
    providerCountersignedAt: COUNTERSIGNED_AT,
    providerSignerId: "officer-1",
    providerSignerName: "A Officer",
    providerSignerEmail: "officer@acme-lending.example",
    providerSignatureSha256,
  })
  return {
    id: APPLICATION_ID,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    agreementGeneratedAt: GENERATED_AT,
    agreementDocumentSha256: AGREEMENT_SHA,
    agreementSignedAt: SIGNED_AT,
    agreementSignedMethod: "portal",
    agreementSignedByUserId: null,
    agreementSignatureData: consumerSignatureData,
    agreementCountersignedAt: COUNTERSIGNED_AT,
    agreementCountersignedById: "officer-1",
    agreementCountersignedByName: "A Officer",
    agreementCountersignedByEmail: "officer@acme-lending.example",
    agreementCountersignatureData: providerSignatureData,
    agreementCountersignatureSha256: providerSignatureSha256,
    agreementCountersignatureEnvelopeSha256: envelopeSha256,
    agreementCountersignedDocumentSha256: AGREEMENT_SHA,
  }
}

function signedMandate() {
  const signatureData = "mandate-signature"
  return {
    agreementSignedAt: SIGNED_AT,
    debitMandatePreparedAt: SIGNED_AT,
    debitMandateReference: "MANDATE-1",
    debitMandateDraftSha256: createHash("sha256").update("mandate-draft").digest("hex"),
    debitMandateEvidence: {},
    debitMandateEvidenceSha256: createHash("sha256").update("mandate-evidence").digest("hex"),
    debitMandateSignedAt: COUNTERSIGNED_AT,
    debitMandateSignedMethod: "portal",
    debitMandateSignatureData: signatureData,
    debitMandateSignatureSha256: createHash("sha256")
      .update(signatureData, "utf8")
      .digest("hex"),
    debitMandateDocumentId: "doc-mandate",
    debitMandateDocumentSha256: createHash("sha256").update("mandate-bytes").digest("hex"),
  }
}

type Overrides = Partial<Omit<ReadinessInput, "application">> & {
  application?: Partial<ReadinessInput["application"]>
}

function input(overrides: Overrides = {}): ReadinessInput {
  const { application: applicationOverrides, ...rest } = overrides
  return {
    kyc: okKyc(),
    documentMismatchCount: 0,
    bureau: {
      score: 700,
      unscoreable: false,
      hasAdverse: false,
      deceased: false,
      underDebtReview: false,
      hasJudgement: false,
      hasNotice: false,
    },
    // 480 is the Sigma floor; below it the gate demands calibration whatever
    // the consumer scored. The route's own 450 fallback is under it.
    bureauPolicy: { bureauMinScore: 600, bureauBlockAdverse: false },
    bureauEvidenceCheck: evidenceBureauCheck,
    tenantConfig: evidenceTenantConfig,
    // The instant the shared fixture's contract was established, so the
    // same-day quote rule holds. A real board passes its own render clock.
    now: new Date("2026-07-20T09:15:00.000Z"),
    ...rest,
    application: {
      status: "UNDER_REVIEW",
      submittedAt: SUBMITTED_AT,
      appliedAmount: PRINCIPAL,
      appliedTermDays: TERM_DAYS,
      affordabilityResult: {
        schemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
        submission: submissionSnapshot(),
      },
      clientAffordabilityDeclaredAt: SUBMITTED_AT,
      recklessLendingAssessed: true,
      recklessLendingAssessedAt: SUBMITTED_AT,
      recklessLendingAssessedById: "officer-1",
      repaymentMethod: "DEBIT_ORDER",
      agreementSignedAt: SIGNED_AT,
      agreementDocumentId: "doc-agreement",
      agreementDocumentSha256: AGREEMENT_SHA,
      creditLife: creditLifeDisclosure(),
      countersign: countersign(),
      mandate: signedMandate(),
      client: {
        bankName: "Capitec",
        bankBranchCode: "470010",
        bankAccountNumber: "1234567890",
        accountType: "SAVINGS",
      },
      disbursementEvidence: disbursementApplicationFixture(),
      ...applicationOverrides,
    },
  }
}

describe("computeReadiness", () => {
  describe("statuses without a chip", () => {
    it.each(["DRAFT", "DISBURSED", "DECLINED", "CANCELLED"])(
      "returns null for %s",
      (status) => {
        expect(computeReadiness(input({ application: { status } }))).toBeNull()
      },
    )
  })

  describe("SUBMITTED", () => {
    it("is READY when composite KYC clears origination and nothing is mismatched", () => {
      const result = computeReadiness(input({ application: { status: "SUBMITTED" } }))
      expect(result).toEqual({ stage: "READY", blockers: [] })
    })

    it("names each outstanding core document", () => {
      const result = computeReadiness(
        input({ application: { status: "SUBMITTED" }, kyc: payslipMissingKyc() }),
      )
      expect(result).toEqual({ stage: "MISSING", blockers: ["Payslip missing"] })
    })

    it("distinguishes an unverified document from one never uploaded", () => {
      const result = computeReadiness(
        input({
          application: { status: "SUBMITTED" },
          kyc: okKyc({
            ok: false,
            okForOrigination: false,
            missingCoreDocuments: ["BANK_STATEMENT"],
            coreDocumentGaps: [
              { docType: "BANK_STATEMENT", state: "awaiting_verification" },
            ],
          }),
        }),
      )
      expect(result?.blockers).toEqual(["Bank Statement unverified"])
    })

    it("blocks on an active manual KYC rejection alone", () => {
      const result = computeReadiness(
        input({
          application: { status: "SUBMITTED" },
          kyc: okKyc({
            ok: false,
            okForOrigination: false,
            manualRejectionActive: true,
            missingCoreDocuments: ["PAYSLIP"],
            coreDocumentGaps: [{ docType: "PAYSLIP", state: "not_uploaded" }],
          }),
        }),
      )
      expect(result).toEqual({
        stage: "MISSING",
        blockers: ["KYC manually rejected"],
      })
    })

    it("blocks on an unresolved document mismatch, which the review route refuses", () => {
      const result = computeReadiness(
        input({ application: { status: "SUBMITTED" }, documentMismatchCount: 2 }),
      )
      expect(result).toEqual({
        stage: "MISSING",
        blockers: ["2 document mismatches"],
      })
    })

    it("does not treat a never-captured selfie as a blocker before payout", () => {
      const result = computeReadiness(
        input({
          application: { status: "SUBMITTED" },
          kyc: okKyc({
            ok: false,
            biometricEvidence: "biometric_evidence_missing",
          }),
        }),
      )
      expect(result).toEqual({ stage: "READY", blockers: [] })
    })

    it("blocks on a selfie that was captured and failed", () => {
      const result = computeReadiness(
        input({
          application: { status: "SUBMITTED" },
          kyc: okKyc({
            ok: false,
            okForOrigination: false,
            biometricAttemptFailed: true,
            biometricEvidence: "match_score_below_threshold",
          }),
        }),
      )
      expect(result?.blockers).toEqual(["Biometric evidence invalid"])
    })
  })

  describe("UNDER_REVIEW", () => {
    it("is READY when every approval gate is satisfied", () => {
      expect(computeReadiness(input())).toEqual({ stage: "READY", blockers: [] })
    })

    it("blocks when the immutable submission affordability snapshot is absent", () => {
      const result = computeReadiness(
        input({ application: { affordabilityResult: null } }),
      )
      expect(result?.blockers).toContain("Affordability evidence missing")
    })

    it("blocks when the submission snapshot no longer matches the submission time", () => {
      const result = computeReadiness(
        input({ application: { submittedAt: new Date("2026-08-02T09:00:00.000Z") } }),
      )
      expect(result?.blockers).toContain("Affordability evidence altered")
    })

    it("blocks when the credit-life disclosure is missing", () => {
      const result = computeReadiness(
        input({
          application: {
            creditLife: { ...creditLifeDisclosure(), creditLifeDisclosureSha256: null },
          },
        }),
      )
      expect(result?.blockers).toContain("Credit-life election missing")
    })

    it("blocks when the client affordability declaration is absent", () => {
      const result = computeReadiness(
        input({ application: { clientAffordabilityDeclaredAt: null } }),
      )
      expect(result?.blockers).toContain("Affordability declaration missing")
    })

    it("blocks when the reckless-lending assessment is incomplete", () => {
      const result = computeReadiness(
        input({ application: { recklessLendingAssessedById: null } }),
      )
      expect(result?.blockers).toContain("Reckless-lending assessment missing")
    })

    it("blocks when there is no current bureau check", () => {
      const result = computeReadiness(input({ bureau: null }))
      expect(result?.blockers).toContain("Bureau check required")
    })

    it("blocks on the bureau risk gate", () => {
      const result = computeReadiness(
        input({
          bureau: {
            score: 300,
            unscoreable: false,
            hasAdverse: false,
            deceased: false,
            underDebtReview: false,
            hasJudgement: false,
            hasNotice: false,
          },
        }),
      )
      expect(result?.blockers).toContain("Bureau risk gate")
    })

    it("reports deceased as its own non-overridable blocker", () => {
      const result = computeReadiness(
        input({
          bureau: {
            score: 700,
            unscoreable: false,
            hasAdverse: false,
            deceased: true,
            underDebtReview: false,
            hasJudgement: false,
            hasNotice: false,
          },
        }),
      )
      expect(result?.blockers).toEqual(["Bureau reports deceased"])
    })

    it("uses the origination-grade KYC gate, not the payout-grade one", () => {
      const result = computeReadiness(
        input({ kyc: okKyc({ ok: false, biometricEvidence: "biometric_evidence_missing" }) }),
      )
      expect(result).toEqual({ stage: "READY", blockers: [] })
    })
  })

  describe("APPROVED", () => {
    // The payout legs are judged against the APPROVED terms, so the
    // credit-life columns and the applied figures must come from the same
    // fixture as the approval evidence — mixing the two proves nothing.
    const evidence = disbursementApplicationFixture()
    const approvedBase = {
      status: "APPROVED",
      appliedAmount: evidence.appliedAmount,
      appliedTermDays: evidence.appliedTermDays,
      creditLife: evidence,
      disbursementEvidence: evidence,
    }
    const approved = (overrides: Overrides = {}) =>
      computeReadiness(
        input({
          ...overrides,
          application: { ...approvedBase, ...(overrides.application ?? {}) },
        }),
      )

    it("is READY when the agreement, countersignature, KYC, banking and mandate all hold", () => {
      expect(approved()).toEqual({ stage: "READY", blockers: [] })
    })

    it("blocks when the agreement has not been signed", () => {
      expect(approved({ application: { agreementSignedAt: null } })?.blockers).toEqual([
        "Agreement not signed",
      ])
    })

    it("blocks when the signed agreement has no integrity binding", () => {
      expect(
        approved({ application: { agreementDocumentSha256: null } })?.blockers,
      ).toContain("Agreement not signed")
    })

    it("blocks when the provider has not countersigned", () => {
      expect(
        approved({
          application: {
            countersign: { ...countersign(), agreementCountersignedAt: null },
          },
        })?.blockers,
      ).toContain("Not countersigned")
    })

    it("applies the payout-grade KYC gate, so a never-captured selfie blocks", () => {
      expect(
        approved({
          kyc: okKyc({ ok: false, biometricEvidence: "biometric_evidence_missing" }),
        })?.blockers,
      ).toContain("Identity not yet verified")
    })

    it("blocks when the payout bank tuple is incomplete", () => {
      expect(
        approved({
          application: {
            client: {
              bankName: null,
              bankBranchCode: "470010",
              bankAccountNumber: "1234567890",
              accountType: "SAVINGS",
            },
          },
        })?.blockers,
      ).toContain("Banking not verified")
    })

    it("blocks a debit order on an OTHER account, which can never carry a mandate", () => {
      expect(
        approved({
          application: {
            client: {
              bankName: "Capitec",
              bankBranchCode: "470010",
              bankAccountNumber: "1234567890",
              accountType: "OTHER",
            },
          },
        })?.blockers,
      ).toContain("Account type not debit-orderable")
    })

    it("blocks when the debit mandate is not signed", () => {
      expect(
        approved({
          application: {
            mandate: { ...signedMandate(), debitMandateSignedAt: null },
          },
        })?.blockers,
      ).toContain("Mandate not signed")
    })

    it("does not require a mandate on the EFT path", () => {
      expect(
        approved({
          application: {
            repaymentMethod: "EFT",
            mandate: { ...signedMandate(), debitMandateSignedAt: null },
          },
        }),
      ).toEqual({ stage: "READY", blockers: [] })
    })

    it("accepts an OTHER account on the EFT path", () => {
      expect(
        approved({
          application: {
            repaymentMethod: "EFT",
            client: {
              bankName: "Capitec",
              bankBranchCode: "470010",
              bankAccountNumber: "1234567890",
              accountType: "OTHER",
            },
          },
        }),
      ).toEqual({ stage: "READY", blockers: [] })
    })

    // The three legs the first cut of this module did not evaluate at all. A
    // card could read "Ready to disburse" over an application with no PASQ
    // acknowledgement, which is an NCA gate, not a nicety.
    it("blocks when the PASQ has not been acknowledged", () => {
      expect(
        approved({
          application: {
            disbursementEvidence: {
              ...disbursementApplicationFixture(),
              pasqAcknowledgedAt: null,
              pasqAcknowledgedBy: null,
            },
          },
        })?.blockers,
      ).toContain("PASQ not acknowledged")
    })

    it("attributes a missing acknowledgement to the PASQ, not to affordability", () => {
      const blockers = approved({
        application: {
          disbursementEvidence: {
            ...disbursementApplicationFixture(),
            pasqAcknowledgedAt: null,
            pasqAcknowledgedBy: null,
          },
        },
      })?.blockers
      // Reporting this as "Affordability changed" would send staff to
      // reassess a decision that is perfectly intact.
      expect(blockers).not.toContain("Affordability changed")
    })

    it("blocks when the immutable approval snapshot is gone", () => {
      const evidenceWithoutApproval = disbursementApplicationFixture()
      expect(
        approved({
          application: {
            disbursementEvidence: {
              ...evidenceWithoutApproval,
              affordabilityResult: {
                ...evidenceWithoutApproval.affordabilityResult,
                approval: undefined,
              },
            },
          },
        })?.blockers,
      ).toContain("Affordability changed")
    })

    it("blocks when the contract schedule is missing", () => {
      const withoutContract = disbursementApplicationFixture()
      expect(
        approved({
          application: {
            disbursementEvidence: {
              ...withoutContract,
              affordabilityResult: {
                ...withoutContract.affordabilityResult,
                contract: undefined,
              },
            },
          },
        })?.blockers,
      ).toContain("Affordability changed")
    })

    it("blocks when the credit-life disclosure no longer matches the approved terms", () => {
      expect(
        approved({
          application: {
            creditLife: {
              ...disbursementApplicationFixture(),
              creditLifeDisclosureSha256: "f".repeat(64),
            },
          },
        })?.blockers,
      ).toContain("Credit life unresolved")
    })

    it("reports the blockers in the order a payout attempt would hit them", () => {
      const blockers = approved({
        kyc: payslipMissingKyc(),
        application: {
          agreementSignedAt: null,
          client: {
            bankName: null,
            bankBranchCode: null,
            bankAccountNumber: null,
            accountType: null,
          },
        },
      })?.blockers
      // signed_agreement, then composite_kyc, then verified_banking — the
      // order of DISBURSEMENT_PRECONDITION_ORDER, so the first blocker on the
      // card is the first one a payout attempt would hit.
      expect(blockers).toEqual([
        "Agreement not signed",
        "Payslip missing",
        "Banking not verified",
      ])
    })

    it("treats a null repayment method as a debit order, fail-closed", () => {
      expect(
        approved({
          application: {
            repaymentMethod: null,
            mandate: { ...signedMandate(), debitMandateSignedAt: null },
          },
        })?.blockers,
      ).toContain("Mandate not signed")
    })
  })
})

describe("readinessReadyLabel", () => {
  it("says what the application is ready FOR at each status", () => {
    expect(readinessReadyLabel("SUBMITTED")).toBe("Ready for review")
    expect(readinessReadyLabel("UNDER_REVIEW")).toBe("Ready to approve")
    expect(readinessReadyLabel("APPROVED")).toBe("Ready to disburse")
  })
})

describe("readinessSummary", () => {
  it("reads the ready label when nothing is outstanding", () => {
    expect(readinessSummary({ stage: "READY", blockers: [] }, "APPROVED")).toBe(
      "Ready to disburse",
    )
  })

  it("names the first two blockers and counts the rest", () => {
    expect(
      readinessSummary(
        { stage: "MISSING", blockers: ["Payslip missing", "Bureau check required"] },
        "UNDER_REVIEW",
      ),
    ).toBe("2 missing: Payslip missing, Bureau check required")
    expect(
      readinessSummary(
        {
          stage: "MISSING",
          blockers: ["Payslip missing", "ID Copy missing", "Bureau check required"],
        },
        "UNDER_REVIEW",
      ),
    ).toBe("3 missing: Payslip missing, ID Copy missing +1")
  })
})
