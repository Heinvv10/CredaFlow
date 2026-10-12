// app/api/applications/[id]/disburse/route.test.ts
//
// Covers credit-life auto-bundle behaviour inside the disburse tx.
// The bundle was previously fire-and-forget (void async IIFE that swallowed
// errors via console.error). Now it runs inside prisma.$transaction so a
// bundle failure rolls back the disburse — the FAIS bundled-exemption
// (NCA s106) requires the policy IS bound, not just attempted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { southAfricanCalendarDate } from "@/lib/compliance/sa-business-days"
import { NextRequest } from "next/server"
import { POST } from "./route"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"
import { calculateCreditLifeMonthlyPremiumCents } from "@/lib/insurance/credit-life-election"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const {
  findUniqueApplication,
  findFirstDocument,
  findManyDocuments,
  findFirstInsuranceProduct,
  findUniqueInsurancePolicy,
  updateInsurancePolicy,
  createClientDocument,
  generateFaisDisclosurePdf,
  saveFile,
  readFile,
  prismaTransaction,
  logAudit,
  triggerNotification,
  tenantConfigFindUnique,
  avsCheckFindFirst,
  creditBureauCheckFindFirst,
  approvalSnapshotMatches,
  readAffordabilitySnapshotStore,
  affordabilityDecisionSnapshotIsIntact,
  affordabilityContractEvidenceIsIntact,
  resolveDisbursementBankDetails,
  verifyCurrentAffordabilityApproval,
  verifyLockedCurrentAffordabilityApproval,
  verifyStoredProviderCountersign,
  verifyStoredPasqBinding,
  verifyPasqDocumentArtifact,
  currentVerifiedBankDetails,
  findVerifiedBankStatementForMandate,
  verifyCurrentStoredDebitMandate,
} = vi.hoisted(() => ({
  findUniqueApplication: vi.fn(),
  findFirstDocument: vi.fn().mockResolvedValue({ id: "doc-1" }),
  findManyDocuments: vi.fn(),
  findFirstInsuranceProduct: vi.fn(),
  // Phase 7 AVS gate — flag-off default keeps every pre-existing test green
  tenantConfigFindUnique: vi.fn().mockResolvedValue({
    collectionsEngineEnabled: false,
    ndiBufferPct: 110,
    bureauMinScore: 450,
    bureauBlockAdverse: false,
  }),
  avsCheckFindFirst: vi.fn().mockResolvedValue(null),
  creditBureauCheckFindFirst: vi.fn().mockResolvedValue({
    id: "bc-1",
    provider: "experian",
    createdAt: new Date("2026-05-01T08:00:00Z"),
    score: 612,
    riskGrade: "LOW",
    unscoreable: false,
    hasAdverse: false,
    deceased: false,
    underDebtReview: false,
    hasJudgement: false,
    hasNotice: false,
    obligations: { totalMonthly: 25000 },
  }),
  approvalSnapshotMatches: vi.fn().mockReturnValue({
    ok: true,
    snapshot: {
      calculator: {
        version: "loan-calculator-v3",
        startDate: "2026-05-01T00:00:00.000Z",
        principalCents: 500000,
        totalInterestCents: 50000,
        initiationFeeCents: 5000,
        serviceFeesCents: 0,
        totalRepayableCents: 555000,
        disbursementAmountCents: 500000,
        recurringInstalmentCents: 555000,
        schedule: [{
          installmentNo: 1,
          dueDate: "2026-06-10T00:00:00.000Z",
          principalDueCents: 500000,
          interestDueCents: 50000,
          feesDueCents: 5000,
          totalDueCents: 555000,
          openingBalanceCents: 500000,
          closingBalanceCents: 0,
        }],
        pricingFingerprint: "test-pricing",
        contractFingerprint: "test-contract",
      },
      decisionFingerprint: "approval-fingerprint",
      outcome: { isAffordable: true },
      inputs: {
        termDays: 30,
        interestRatePm: 0.05,
        interestModel: "FLAT",
      },
    },
  }),
  readAffordabilitySnapshotStore: vi.fn().mockReturnValue({
    submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
    contract: {
      version: "affordability-contract-v1",
      establishedAt: "2026-05-10T00:00:00.000Z",
      approvalDecisionFingerprint: "approval-fingerprint",
      calculator: {
        version: "loan-calculator-v3",
        startDate: "2026-05-10T00:00:00.000Z",
        principalCents: 500000,
        totalInterestCents: 50000,
        initiationFeeCents: 5000,
        serviceFeesCents: 0,
        totalRepayableCents: 555000,
        disbursementAmountCents: 500000,
        recurringInstalmentCents: 555000,
        schedule: [{
          installmentNo: 1,
          dueDate: "2026-06-10T00:00:00.000Z",
          principalDueCents: 500000,
          interestDueCents: 50000,
          feesDueCents: 5000,
          totalDueCents: 555000,
          openingBalanceCents: 500000,
          closingBalanceCents: 0,
        }],
        pricingFingerprint: "test-pricing",
        contractFingerprint: "signed-contract-schedule",
      },
      fingerprint: "contract-fingerprint",
    },
  }),
  affordabilityDecisionSnapshotIsIntact: vi.fn().mockReturnValue(true),
  affordabilityContractEvidenceIsIntact: vi.fn().mockReturnValue(true),
  resolveDisbursementBankDetails: vi.fn().mockReturnValue({
    bank: "FNB",
    accountNo: "12345",
    branchCode: "250655",
    accountType: "SAVINGS",
    bankRef: "REF",
    overrideUsed: false,
    overrideProof: null,
  }),
  verifyCurrentAffordabilityApproval: vi.fn(),
  verifyLockedCurrentAffordabilityApproval: vi.fn().mockResolvedValue({
    ok: true,
    application: {},
    approval: {},
    calculation: {},
  }),
  verifyStoredProviderCountersign: vi.fn(),
  verifyStoredPasqBinding: vi.fn(),
  verifyPasqDocumentArtifact: vi.fn(),
  currentVerifiedBankDetails: vi.fn(),
  findVerifiedBankStatementForMandate: vi.fn(),
  verifyCurrentStoredDebitMandate: vi.fn(),
  // Post-commit FAIS/PPR issuance: the bundled policy is refetched with
  // its product/insurer/client, a disclosure PDF is generated + stored, then
  // the policy is stamped faisDisclosureAt/faisDisclosurePdfUrl/pprIssuedAt.
  findUniqueInsurancePolicy: vi.fn().mockResolvedValue({
    id: "pol-1", clientId: "client-1", policyNumber: "CL-TESTREF",
    sumAssured: 5000, premiumAmount: 50, insurer: null,
    product: { name: "Credit Life" }, insurer_rel: { name: "Clientele Life" },
    client: { firstName: "A", lastName: "B", idNumber: "9001016000082" },
  }),
  updateInsurancePolicy: vi.fn().mockResolvedValue({ id: "pol-1" }),
  createClientDocument: vi.fn().mockResolvedValue({ id: "disc-doc-1" }),
  generateFaisDisclosurePdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4 fais")),
  saveFile: vi.fn().mockResolvedValue({ storagePath: "/x/disc.pdf", fileSize: 13 }),
  readFile: vi.fn(),
  prismaTransaction: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
  triggerNotification: vi.fn().mockResolvedValue(undefined),
}))

// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: async (...args: unknown[]) => {
        const application = await findUniqueApplication(...args)
        return application
          ? {
              submittedAt: new Date("2026-05-01T00:00:00.000Z"),
              agreementGeneratedAt: new Date("2026-05-10T00:00:00.000Z"),
              agreementDocumentId: "agreement-doc-1",
              agreementDocumentSha256: AGREEMENT_PDF_SHA256,
              approvedPasqDocumentSha256: "d".repeat(64),
              debitMandateSignedAt: DEBIT_MANDATE_SIGNED_AT,
              debitMandateSignatureSha256: VERIFIED_DEBIT_MANDATE.signatureSha256,
              debitMandateDocumentId: VERIFIED_DEBIT_MANDATE.documentId,
              debitMandateDocumentSha256: VERIFIED_DEBIT_MANDATE.documentSha256,
              bureauReviewGeneration: "review-generation-1",
              existingDebtObligations: [],
              ...DEFAULT_CREDIT_LIFE_APPLICATION,
              ...application,
              client: {
                id: "client-1",
                idNumber: "9001016000082",
                firstName: "A",
                lastName: "B",
                dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
                kycStatus: "VERIFIED",
                debtObligations: [],
                ...application.client,
              },
            }
          : application
      },
    },
    clientDocument: {
      findFirst: findFirstDocument,
      findMany: findManyDocuments,
      create: createClientDocument,
    },
    insuranceProduct: { findFirst: findFirstInsuranceProduct },
    insurancePolicy: { findUnique: findUniqueInsurancePolicy, update: updateInsurancePolicy },
    // NCA s.81 bureau-required gate (route:74) — return a current check so the
    // gate passes and the test reaches the bundle.
    creditBureauCheck: { findFirst: creditBureauCheckFindFirst },
    client: { findUnique: vi.fn().mockResolvedValue(null) }, // skips WA notification
    tenantConfig: { findUnique: tenantConfigFindUnique },
    avsCheck: { findFirst: avsCheckFindFirst },
    $transaction: prismaTransaction,
  },
}))

vi.mock("@/lib/pdf/faisDisclosure", () => ({ generateFaisDisclosurePdf }))
const getLenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config/identity")>()),
  getLenderIdentity: (...args: unknown[]) => getLenderIdentityMock(...args),
}))
vi.mock("@/lib/storage", () => ({ saveFile, readFile }))
vi.mock("@/lib/compliance/provider-countersign", () => ({
  verifyStoredProviderCountersign: (...args: unknown[]) =>
    verifyStoredProviderCountersign(...args),
}))
vi.mock("@/lib/compliance/pasq", () => ({
  verifyStoredPasqBinding: (...args: unknown[]) => verifyStoredPasqBinding(...args),
}))
vi.mock("@/lib/compliance/pasq-document.server", () => ({
  verifyPasqDocumentArtifact: (...args: unknown[]) => verifyPasqDocumentArtifact(...args),
}))
vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  currentVerifiedBankDetails: (...args: unknown[]) =>
    currentVerifiedBankDetails(...args),
  findVerifiedBankStatementForMandate: (...args: unknown[]) =>
    findVerifiedBankStatementForMandate(...args),
  verifyCurrentStoredDebitMandate: (...args: unknown[]) =>
    verifyCurrentStoredDebitMandate(...args),
}))
vi.mock("@/lib/affordability/snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/affordability/snapshot")>()),
  approvalSnapshotMatches,
  readAffordabilitySnapshotStore,
  affordabilityDecisionSnapshotIsIntact,
  affordabilityContractEvidenceIsIntact,
}))
vi.mock("@/lib/compliance/bureau-subject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/bureau-subject")>()),
  bureauCheckMatchesSubject: vi.fn().mockReturnValue(true),
}))
vi.mock("@/lib/compliance/avs-subject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/avs-subject")>()),
  avsCheckMatchesSubject: vi.fn().mockReturnValue(true),
}))
vi.mock("@/lib/affordability/current-approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/affordability/current-approval")>()),
  verifyCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyCurrentAffordabilityApproval(...args),
  verifyLockedCurrentAffordabilityApproval,
}))

vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    fn: (t: { id: string; name: string }) => unknown
  ) => fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example", role: "LOAN_ADMIN" },
  }),
}))

vi.mock("@/lib/auth-guards", () => ({
  canDo: vi.fn().mockReturnValue(true),
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example", role: "LOAN_ADMIN" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

vi.mock("@/lib/notifications", () => ({
  triggerNotification,
}))

vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
  WA_TEMPLATES: { loan_disbursed: () => "msg" },
}))

vi.mock("@/lib/disbursement-bank-details", () => ({
  DisbursementBankDetailsError: class extends Error {},
  resolveDisbursementBankDetails,
}))

vi.mock("@/lib/loan-calculator", () => ({
  calculateLoan: vi.fn().mockReturnValue({
    principal: 500000,
    totalInterest: 50000,
    initiationFee: 5000,
    serviceFees: 0,
    totalRepayable: 555000,
    disbursementAmount: 500000,
    monthlyInstalment: 555000,
    schedule: [{
      installmentNo: 1,
      dueDate: new Date("2026-06-01"),
      principalDue: 500000,
      interestDue: 50000,
      feesDue: 5000,
      totalDue: 555000,
      openingBalance: 500000,
      closingBalance: 0,
    }],
  }),
}))

vi.mock("@/lib/utils", () => ({
  generateReference: (prefix: string) => `${prefix}-TESTREF`,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const AGREEMENT_PDF = Buffer.from("%PDF-1.4 signed agreement")
const AGREEMENT_PDF_SHA256 = sha256DocumentBytes(AGREEMENT_PDF)
const DEBIT_MANDATE_PDF = Buffer.from("%PDF-1.4 signed debit mandate")
const DEBIT_MANDATE_PDF_SHA256 = sha256DocumentBytes(DEBIT_MANDATE_PDF)
const DEBIT_MANDATE_SIGNED_AT = new Date("2026-05-10T10:00:00.000Z")
const BOUND_DEBIT_MANDATE_DOCUMENT = {
  id: "mandate-doc-1",
  storagePath: "/mandates/app-1.pdf",
  contentSha256: DEBIT_MANDATE_PDF_SHA256,
}
const VERIFIED_DEBIT_MANDATE = {
  ok: true as const,
  signedAt: DEBIT_MANDATE_SIGNED_AT,
  signatureSha256: "a".repeat(64),
  documentId: BOUND_DEBIT_MANDATE_DOCUMENT.id,
  documentSha256: DEBIT_MANDATE_PDF_SHA256,
  draftDocumentSha256: "b".repeat(64),
  evidenceSha256: "c".repeat(64),
  evidence: {
    collectionReference: "LN-MANDATE-REF",
    bankStatement: { documentId: "bank-doc-1" },
  },
  bankStatement: {
    documentId: "bank-doc-1",
    documentSha256: "9".repeat(64),
    verifiedAt: "2026-05-10T09:00:00.000Z",
  },
}
const CREDIT_LIFE_DISCLOSURE = {
  version: "credit-life-election-v1" as const,
  election: "ACCEPTED" as const,
  principalCents: 500000,
  termDays: 30,
  monthlyPremiumCents: 2250,
  productId: "ins-prod-1",
  productName: "Credit Life",
  insurerId: "insurer-1",
  insurerName: "Clientele Life",
}
const CREDIT_LIFE_DISCLOSURE_SHA256 =
  createCreditLifeDisclosureSha256(CREDIT_LIFE_DISCLOSURE)
const DEFAULT_CREDIT_LIFE_APPLICATION = {
  creditLifeElection: CREDIT_LIFE_DISCLOSURE.election,
  creditLifeProductId: CREDIT_LIFE_DISCLOSURE.productId,
  creditLifeProductName: CREDIT_LIFE_DISCLOSURE.productName,
  creditLifeInsurerId: CREDIT_LIFE_DISCLOSURE.insurerId,
  creditLifeInsurerName: CREDIT_LIFE_DISCLOSURE.insurerName,
  creditLifeMonthlyPremiumCents: CREDIT_LIFE_DISCLOSURE.monthlyPremiumCents,
  creditLifeDisclosureVersion: CREDIT_LIFE_DISCLOSURE.version,
  creditLifeDisclosureSha256: CREDIT_LIFE_DISCLOSURE_SHA256,
  creditLifeDisclosureAcknowledgedAt: new Date("2026-05-01T00:00:00.000Z"),
  creditLifeDisclosureAcknowledgedBy: "client-1",
}
const DEFAULT_CREDIT_LIFE_ARTIFACT = {
  creditLifeAutoBundleEligible: true,
  creditLifeElection: CREDIT_LIFE_DISCLOSURE.election,
  creditLifeProductId: CREDIT_LIFE_DISCLOSURE.productId,
  creditLifeProductName: CREDIT_LIFE_DISCLOSURE.productName,
  creditLifeInsurerId: CREDIT_LIFE_DISCLOSURE.insurerId,
  creditLifeInsurerName: CREDIT_LIFE_DISCLOSURE.insurerName,
  creditLifeMonthlyPremiumCents: CREDIT_LIFE_DISCLOSURE.monthlyPremiumCents,
  creditLifeDisclosureVersion: CREDIT_LIFE_DISCLOSURE.version,
  creditLifeDisclosureSha256: CREDIT_LIFE_DISCLOSURE_SHA256,
}
function buildCreditLifeTestEvidence(principalCents: number, termDays: number) {
  const disclosure = {
    ...CREDIT_LIFE_DISCLOSURE,
    principalCents,
    termDays,
    monthlyPremiumCents: calculateCreditLifeMonthlyPremiumCents(principalCents),
  }
  const disclosureSha256 = createCreditLifeDisclosureSha256(disclosure)
  return {
    application: {
      ...DEFAULT_CREDIT_LIFE_APPLICATION,
      creditLifeMonthlyPremiumCents: disclosure.monthlyPremiumCents,
      creditLifeDisclosureSha256: disclosureSha256,
    },
    artifact: {
      ...DEFAULT_CREDIT_LIFE_ARTIFACT,
      creditLifeAutoBundleEligible: false,
      creditLifeMonthlyPremiumCents: disclosure.monthlyPremiumCents,
      creditLifeDisclosureSha256: disclosureSha256,
    },
  }
}
const BOUND_AGREEMENT_DOCUMENT = {
  id: "agreement-doc-1",
  storagePath: "/agreements/app-1.pdf",
  contentSha256: AGREEMENT_PDF_SHA256,
}
const ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED =
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
const BIOMETRIC_TEST_SUBJECT = {
  id: "client-1",
  idNumber: "9001016000082",
  firstName: "A",
  lastName: "B",
  dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
}
const PASSING_BIOMETRIC_DOCUMENT = {
  id: "selfie-1",
  deletedAt: null,
  verified: true,
  extractionStatus: "done",
  extractionResult: {
    faceDetected: { value: true },
    facesCount: { value: 1 },
    isLive: { value: true },
    quality: { value: "good" },
  },
  extractionError: null,
  validationMismatch: false,
  validationScore: 98,
  biometricMatchScore: 98,
  biometricLiveness: 97,
  biometricVerifiedAt: new Date("2026-05-10T09:00:00.000Z"),
  biometricResult: {
    ok: true,
    verified: true,
    matchScore: 98,
    livenessScore: 97,
    provider: "vlm-face-match-v3",
    faceModel: PASSING_FACE_MODEL_EVIDENCE,
    idPhotoKind: "photograph",
    idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true,
    selfieIsRealPhotograph: true,
    samePerson: "same",
    faceMatch: true,
    matchConfidence: 0.98,
    livenessConfidence: 0.97,
    subjectFingerprint: biometricSubjectFingerprint(BIOMETRIC_TEST_SUBJECT),
  },
}

const VERIFIED_CORE_DOCUMENTS = [
  { docType: "ID_COPY", verified: true, verificationNote: null },
  { docType: "PROOF_OF_ADDRESS", verified: true, verificationNote: null },
  { docType: "PAYSLIP", verified: true, verificationNote: null },
  { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
]

const passingApprovalSnapshotMatch = {
  ok: true as const,
  snapshot: {
    decisionFingerprint: "approval-fingerprint",
    outcome: { isAffordable: true },
    inputs: {
      principalCents: 500000,
      termDays: 30,
      interestRatePm: 0.05,
      interestModel: "FLAT" as const,
    },
    calculator: {
      version: "loan-calculator-v3",
      startDate: "2026-05-01T00:00:00.000Z",
      principalCents: 500000,
      totalInterestCents: 50000,
      initiationFeeCents: 5000,
      serviceFeesCents: 0,
      totalRepayableCents: 555000,
      disbursementAmountCents: 500000,
      recurringInstalmentCents: 555000,
      schedule: [{
        installmentNo: 1,
        dueDate: "2026-06-01T00:00:00.000Z",
        principalDueCents: 500000,
        interestDueCents: 50000,
        feesDueCents: 5000,
        totalDueCents: 555000,
        openingBalanceCents: 500000,
        closingBalanceCents: 0,
      }],
      pricingFingerprint: "test-pricing",
      contractFingerprint: "test-contract",
    },
  },
}

const passingContract = {
  version: "affordability-contract-v1",
  establishedAt: "2026-05-10T00:00:00.000Z",
  acceptedPasqDocumentSha256: "d".repeat(64),
  approvalDecisionFingerprint: "approval-fingerprint",
  calculator: {
    ...passingApprovalSnapshotMatch.snapshot.calculator,
    startDate: "2026-05-10T00:00:00.000Z",
    schedule: passingApprovalSnapshotMatch.snapshot.calculator.schedule.map((item) => ({
      ...item,
      dueDate: "2026-06-10T00:00:00.000Z",
    })),
    contractFingerprint: "signed-contract-schedule",
  },
  fingerprint: "contract-fingerprint",
}

function makeRequest(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/applications/app-1/disburse", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

/**
 * Build a happy-path tx mock. `behaviour` lets a test inject:
 *   - bundlePolicyCreateThrows: simulate insurance.create P2002 / DB error
 *   - product: null  → no creditLifeProduct, bundle skipped
 *   - referredClient / tenantConfig / referralCode: drive the referral
 *     commission accrual (lib/referral-agents/commission.ts, called inside the
 *     tx right after tx.loan.create). Default = borrower not referred, so
 *     the accrual no-ops (tx.client.findUnique returns referralCodeId: null).
 */
function buildTxMock(opts: {
  bundlePolicyCreateThrows?: Error
  auditLogCreateThrows?: Error
  auditLogCreateThrowsForAction?: string
  product?: { id: string } | null
  referredClient?: { referralCodeId: string | null } | null
  tenantConfig?: { referralCommissionBps: number } | null
  affordabilityTenantConfig?: {
    collectionsEngineEnabled: boolean
    ndiBufferPct: number
    bureauMinScore: number
    bureauBlockAdverse: boolean
  } | null
  referralCode?: { id: string; agentId: string; agent: { status: string; commissionBps: number | null } } | null
  // R-09 TOCTOU guard: the application-status updateMany's count. Default 1
  // (the normal, uncontested case); set 0 to simulate a concurrent disburse
  // having already claimed the application, which must throw inside the tx.
  applicationUpdateManyCount?: number
  agreementArtifactData?: unknown
  agreementArtifactMissing?: boolean
}) {
  const insurancePolicyCreate = opts.bundlePolicyCreateThrows
    ? vi.fn().mockRejectedValue(opts.bundlePolicyCreateThrows)
    : vi.fn().mockResolvedValue({ id: "pol-1" })
  const referralEventCreate = vi.fn().mockResolvedValue({ id: "tfe-1" })
  const loanCreate = vi.fn().mockResolvedValue({
    id: "loan-1",
    reference: "LN-TESTREF",
    clientId: "client-1",
    outstandingPrincipal: 500000,
    principal: 500000,
  })
  const scheduleCreateMany = vi.fn().mockResolvedValue({ count: 1 })
  const auditLogCreate = vi.fn().mockImplementation(
    (args: { data?: { action?: string } }) => {
      if (
        opts.auditLogCreateThrows &&
        (!opts.auditLogCreateThrowsForAction ||
          args.data?.action === opts.auditLogCreateThrowsForAction)
      ) {
        return Promise.reject(opts.auditLogCreateThrows)
      }
      return Promise.resolve({ id: "audit-1" })
    },
  )
  const queryRaw = vi.fn().mockImplementation(
    (query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join(" ") ?? String(query)
      return Promise.resolve(
        sql.includes('FROM "InsuranceProduct"')
          ? [{ id: "ins-prod-1" }]
          : [{ id: "locked-doc" }],
      )
    },
  )
  const executeRawUnsafe = vi.fn().mockResolvedValue(0)
  const insuranceProductFindFirst = vi.fn().mockResolvedValue(
    opts.product === undefined
      ? { id: "ins-prod-1", insurerId: "insurer-1", commissionRate: 0.15 }
      : opts.product,
  )
  const complianceRecordFindFirst = vi.fn().mockResolvedValue(
    opts.agreementArtifactMissing
      ? null
      : {
          data: opts.agreementArtifactData === undefined
            ? DEFAULT_CREDIT_LIFE_ARTIFACT
            : opts.agreementArtifactData,
        },
  )

  findFirstInsuranceProduct.mockReset()
  // Inside-tx insuranceProduct.findFirst — return product or null per opts.
  // The route uses `tx.insuranceProduct.findFirst`, so mock it on the tx stub.

  prismaTransaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        loan: {
          create: loanCreate,
        },
        repaymentSchedule: { createMany: scheduleCreateMany },
        loanApplication: {
          findUnique: async (...args: unknown[]) => {
            const application = await findUniqueApplication(...args)
            return application
              ? {
                  submittedAt: new Date("2026-05-01T00:00:00.000Z"),
                  agreementGeneratedAt: new Date("2026-05-10T00:00:00.000Z"),
                  agreementDocumentId: "agreement-doc-1",
                  agreementDocumentSha256: AGREEMENT_PDF_SHA256,
                  approvedPasqDocumentSha256: "d".repeat(64),
                  debitMandateSignedAt: DEBIT_MANDATE_SIGNED_AT,
                  debitMandateSignatureSha256: VERIFIED_DEBIT_MANDATE.signatureSha256,
                  debitMandateDocumentId: VERIFIED_DEBIT_MANDATE.documentId,
                  debitMandateDocumentSha256: VERIFIED_DEBIT_MANDATE.documentSha256,
                  bureauReviewGeneration: "review-generation-1",
                  existingDebtObligations: [],
                  ...DEFAULT_CREDIT_LIFE_APPLICATION,
                  ...application,
                  client: {
                    id: "client-1",
                    idNumber: "9001016000082",
                    firstName: "A",
                    lastName: "B",
                    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
                    kycStatus: "VERIFIED",
                    debtObligations: [],
                    ...application.client,
                  },
                }
              : application
          },
          updateMany: vi.fn().mockResolvedValue({ count: opts.applicationUpdateManyCount ?? 1 }),
        },
        creditBureauCheck: { findFirst: creditBureauCheckFindFirst },
        clientDocument: {
          findFirst: findFirstDocument,
          findMany: findManyDocuments,
        },
        complianceRecord: {
          findFirst: complianceRecordFindFirst,
        },
        avsCheck: { findFirst: avsCheckFindFirst },
        insuranceProduct: {
          findFirst: insuranceProductFindFirst,
        },
        insurancePolicy: { create: insurancePolicyCreate },
        // referral commission accrual (lib/referral-agents/commission.ts).
        client: { findUnique: vi.fn().mockResolvedValue(opts.referredClient ?? { referralCodeId: null }) },
        tenantConfig: {
          findUnique: vi.fn().mockImplementation((args: { select?: Record<string, boolean> }) =>
            args.select?.ndiBufferPct
              ? (opts.affordabilityTenantConfig ?? {
                  collectionsEngineEnabled: false,
                  ndiBufferPct: 110,
                  bureauMinScore: 450,
                  bureauBlockAdverse: false,
                })
              : (opts.tenantConfig ?? { referralCommissionBps: 0 }),
          ),
        },
        referralCode: { findFirst: vi.fn().mockResolvedValue(opts.referralCode ?? null) },
        referralEvent: { findFirst: vi.fn().mockResolvedValue(null), create: referralEventCreate },
        auditLog: { create: auditLogCreate },
        $queryRaw: queryRaw,
        $executeRawUnsafe: executeRawUnsafe,
      }
      return fn(tx)
    }
  )

  return {
    insurancePolicyCreate,
    referralEventCreate,
    loanCreate,
    scheduleCreateMany,
    auditLogCreate,
    queryRaw,
    executeRawUnsafe,
    complianceRecordFindFirst,
    insuranceProductFindFirst,
  }
}

beforeEach(() => {
  getLenderIdentityMock.mockReset()
  getLenderIdentityMock.mockImplementation(async () => {
    const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
    return parseLenderIdentity(VALID_LENDER_COLUMNS)
  })
  process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = "true"
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-05-10T12:00:00.000Z"))
  readAffordabilitySnapshotStore.mockReturnValue({
    submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
    contract: passingContract,
  })
  affordabilityDecisionSnapshotIsIntact.mockReturnValue(true)
  affordabilityContractEvidenceIsIntact.mockReturnValue(true)
  approvalSnapshotMatches.mockReturnValue(passingApprovalSnapshotMatch)
  resolveDisbursementBankDetails.mockReset()
  resolveDisbursementBankDetails.mockReturnValue({
    bank: "FNB",
    accountNo: "12345",
    branchCode: "250655",
    accountType: "SAVINGS",
    bankRef: "REF",
    overrideUsed: false,
    overrideProof: null,
  })
  tenantConfigFindUnique.mockReset()
  tenantConfigFindUnique.mockResolvedValue({
    collectionsEngineEnabled: false,
    ndiBufferPct: 110,
    bureauMinScore: 450,
    bureauBlockAdverse: false,
  })
  avsCheckFindFirst.mockReset()
  avsCheckFindFirst.mockResolvedValue(null)
  findFirstDocument.mockReset()
  findFirstDocument.mockImplementation((args: { where?: { docType?: string } }) =>
    Promise.resolve(
      args.where?.docType === "CREDIT_AGREEMENT"
        ? BOUND_AGREEMENT_DOCUMENT
        : args.where?.docType === "DEBIT_MANDATE"
          ? BOUND_DEBIT_MANDATE_DOCUMENT
        : args.where?.docType === "SELFIE"
          ? PASSING_BIOMETRIC_DOCUMENT
          : { id: "bank-doc-1" },
    ),
  )
  findManyDocuments.mockReset()
  findManyDocuments.mockResolvedValue(VERIFIED_CORE_DOCUMENTS)
  readFile.mockReset()
  readFile.mockImplementation((storagePath: string) =>
    Promise.resolve(
      storagePath === BOUND_DEBIT_MANDATE_DOCUMENT.storagePath
        ? DEBIT_MANDATE_PDF
        : AGREEMENT_PDF,
    ),
  )
  verifyLockedCurrentAffordabilityApproval.mockResolvedValue({
    ok: true,
    application: {},
    approval: {},
    calculation: {},
  })
  verifyCurrentAffordabilityApproval.mockReset()
  verifyCurrentAffordabilityApproval.mockImplementation(() => {
    const result = approvalSnapshotMatches()
    return result.ok
      ? { ok: true, approval: result.snapshot, calculation: {} }
      : result
  })
  verifyStoredProviderCountersign.mockReset()
  verifyStoredProviderCountersign.mockReturnValue({
    ok: true,
    evidence: {
      countersignedAt: new Date("2026-05-10T02:00:00.000Z"),
      countersignedById: "provider-1",
      countersignedByName: "Provider Representative",
      countersignedByEmail: "provider@example.test",
      signatureData: "Provider Representative",
      signatureSha256: "f".repeat(64),
      envelopeSha256: "e".repeat(64),
      consumerSignatureSha256: "c".repeat(64),
      documentSha256: AGREEMENT_PDF_SHA256,
    },
  })
  verifyStoredPasqBinding.mockReset()
  verifyStoredPasqBinding.mockReturnValue({
    ok: true,
    documentId: "pasq-doc-1",
    documentSha256: "d".repeat(64),
    evidence: {
      version: "pasq-v3",
      evidenceSha256: "e".repeat(64),
      calculator: passingContract.calculator,
      creditLife: {
        election: "ACCEPTED",
        monthlyPremiumCents: 2_250,
        totalPremiumCents: 2_250,
      },
      billing: {
        version: "credit-life-billing-v1",
        collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
        recurringPaymentCents: 557_250,
        totalRepayableCents: 557_250,
        schedule: [{
          installmentNo: 1,
          dueDate: "2026-06-10T00:00:00.000Z",
          principalDueCents: 500_000,
          interestDueCents: 50_000,
          baseFeesDueCents: 5_000,
          creditLifePremiumDueCents: 2_250,
          feesDueCents: 7_250,
          totalDueCents: 557_250,
          openingBalanceCents: 500_000,
          closingBalanceCents: 0,
        }],
      },
    },
  })
  verifyPasqDocumentArtifact.mockReset()
  verifyPasqDocumentArtifact.mockResolvedValue({
    ok: true,
    document: {},
    bytes: Buffer.from("%PDF-1.4 PASQ"),
  })
  verifyCurrentStoredDebitMandate.mockReset()
  verifyCurrentStoredDebitMandate.mockResolvedValue(VERIFIED_DEBIT_MANDATE)
  currentVerifiedBankDetails.mockReset()
  currentVerifiedBankDetails.mockReturnValue({
    bankName: "FNB",
    branchCode: "250655",
    accountNumber: "12345",
    accountType: "SAVINGS",
  })
  findVerifiedBankStatementForMandate.mockReset()
  findVerifiedBankStatementForMandate.mockResolvedValue({
    ok: true,
    evidence: VERIFIED_DEBIT_MANDATE.bankStatement,
  })
})

afterEach(() => {
  if (ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED === undefined) {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  } else {
    process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED = ORIGINAL_CREDIT_LIFE_AUTO_BUNDLE_ENABLED
  }
  vi.useRealTimers()
  vi.clearAllMocks()
  readAffordabilitySnapshotStore.mockReturnValue({
    submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
    contract: passingContract,
  })
  affordabilityDecisionSnapshotIsIntact.mockReturnValue(true)
  affordabilityContractEvidenceIsIntact.mockReturnValue(true)
  approvalSnapshotMatches.mockReturnValue({
    ok: true,
    snapshot: {
      decisionFingerprint: "approval-fingerprint",
      outcome: { isAffordable: true },
      inputs: {
        principalCents: 500000,
        termDays: 30,
        interestRatePm: 0.05,
        interestModel: "FLAT",
      },
      calculator: {
        version: "loan-calculator-v3",
        startDate: "2026-05-01T00:00:00.000Z",
        principalCents: 500000,
        totalInterestCents: 50000,
        initiationFeeCents: 5000,
        serviceFeesCents: 0,
        totalRepayableCents: 555000,
        disbursementAmountCents: 500000,
        recurringInstalmentCents: 555000,
        schedule: [{
          installmentNo: 1,
          dueDate: "2026-06-01T00:00:00.000Z",
          principalDueCents: 500000,
          interestDueCents: 50000,
          feesDueCents: 5000,
          totalDueCents: 555000,
          openingBalanceCents: 500000,
          closingBalanceCents: 0,
        }],
        pricingFingerprint: "test-pricing",
        contractFingerprint: "test-contract",
      },
    },
  })
})

describe("POST /api/applications/[id]/disburse — payout gates, credit-life bundling and in-transaction invariants", () => {
  it("blocks before the money transaction without provider countersign evidence", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      agreementDocumentId: "agreement-doc-1",
      agreementDocumentSha256: AGREEMENT_PDF_SHA256,
      clientId: "client-1",
      client: {},
      product: {},
    })
    verifyStoredProviderCountersign.mockReturnValue({ ok: false, reason: "missing" })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "provider_countersign",
      countersignEvidence: "missing",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before the money transaction when the approved PASQ bytes are tampered", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { monthlyIncome: 1_500_000, monthlyExpenses: 800_000, debtObligations: [] },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    verifyPasqDocumentArtifact.mockResolvedValue({ ok: false, reason: "hash_mismatch" })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_changed",
      pasqDocument: "hash_mismatch",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("rolls back when the PASQ artifact changes after preflight", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { monthlyIncome: 1_500_000, monthlyExpenses: 800_000, debtObligations: [] },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    verifyPasqDocumentArtifact
      .mockResolvedValueOnce({ ok: true, document: {}, bytes: Buffer.from("pasq") })
      .mockResolvedValueOnce({ ok: false, reason: "missing" })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_document_changed",
    }))
    expect(loanCreate).not.toHaveBeenCalled()
  })

  // The payout guards run TWICE: as preflight preconditions in TypeScript, and
  // again as BEFORE-trigger RAISE ... 23514 on the DISBURSED write. The second
  // layer must not surface as the SAME bare 500 a system failure gives, which
  // would discard the guard's own sentence naming the missing evidence and leave
  // an operator unable to tell a refused payout from a broken system.
  it("answers a database guard refusal with its reason, not a bare 500", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { monthlyIncome: 1_500_000, monthlyExpenses: 800_000, debtObligations: [] },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    // Exactly what Postgres raises, wrapped the way Prisma delivers it.
    const guardError = new Error(
      "\nInvalid `prisma.loanApplication.updateMany()` invocation:\n\n\n"
      + "Raw query failed. Code: `23514`. Message: `Loan disbursement requires the "
      + "signed mandate bank statement to match the complete payout bank tuple`",
    )
    prismaTransaction.mockRejectedValueOnce(guardError)

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    const body = await response.json() as { error: string; disbursementGuard: string }
    expect(body.disbursementGuard).toBe("database_guard_refused")
    // The guard's OWN sentence reaches the operator — a generic summary would
    // not tell them which evidence is missing.
    expect(body.error).toContain("Loan disbursement requires the signed mandate bank statement")
    expect(body.error).not.toContain("Failed to disburse loan")
  })

  it("still returns 500 for a genuine failure that is not a guard refusal", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { monthlyIncome: 1_500_000, monthlyExpenses: 800_000, debtObligations: [] },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    prismaTransaction.mockRejectedValueOnce(new Error("connection terminated unexpectedly"))

    const response = await POST(makeRequest(), ctx)

    // A system failure must NOT be relabelled as a refusal — that would tell an
    // operator to go fix evidence that is perfectly fine.
    expect(response.status).toBe(500)
  })

  it("blocks a legacy signed agreement without a byte binding", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      agreementDocumentId: null,
      agreementDocumentSha256: null,
      clientId: "client-1",
      client: {},
      product: {},
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/integrity binding/i)
    expect(findFirstDocument).not.toHaveBeenCalled()
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before the money transaction when signed agreement bytes are changed", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      clientId: "client-1",
      client: {},
      product: {},
    })
    readFile.mockResolvedValue(Buffer.from("%PDF-1.4 changed"))

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/integrity check/i)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before the money transaction when current KYC was revoked after approval", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "FAILED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "kyc_changed",
      error: expect.stringContaining("current KYC status is not verified"),
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks cached VERIFIED KYC when identity, address, and income evidence are missing", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    findManyDocuments.mockResolvedValueOnce([
      { docType: "BANK_STATEMENT", verified: true, verificationNote: null },
    ])

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: null,
      missingDocs: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP"],
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks a verified client when the stored selfie proves no face or liveness", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    findFirstDocument.mockImplementation((args: { where?: { docType?: string } }) =>
      Promise.resolve(
        args.where?.docType === "CREDIT_AGREEMENT"
          ? BOUND_AGREEMENT_DOCUMENT
          : args.where?.docType === "SELFIE"
            ? {
                ...PASSING_BIOMETRIC_DOCUMENT,
                extractionResult: {
                  ...PASSING_BIOMETRIC_DOCUMENT.extractionResult,
                  faceDetected: { value: false },
                  facesCount: { value: 0 },
                  isLive: { value: false },
                },
              }
            : { id: "bank-doc-1" },
      ),
    )

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: "face_not_detected",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("uses the latest selfie attempt instead of falling back to older accepted evidence", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    findFirstDocument.mockImplementation((args: {
      where?: { docType?: string; verified?: boolean }
      orderBy?: unknown
    }) => {
      if (args.where?.docType === "CREDIT_AGREEMENT") {
        return Promise.resolve(BOUND_AGREEMENT_DOCUMENT)
      }
      if (args.where?.docType === "DEBIT_MANDATE") {
        return Promise.resolve(BOUND_DEBIT_MANDATE_DOCUMENT)
      }
      if (args.where?.docType === "SELFIE") {
        if ((args.where as { OR?: unknown }).OR) {
          // Blocking-candidate probe for the in-person route: no live
          // biometric attempt in these scenarios.
          return Promise.resolve(null)
        }
        expect(args.where).not.toHaveProperty("verified")
        expect(args.orderBy).toEqual([
          { biometricAttemptSequence: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ])
        return Promise.resolve({
          ...PASSING_BIOMETRIC_DOCUMENT,
          verified: false,
        })
      }
      return Promise.resolve({ id: "bank-doc-1" })
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: "document_not_verified",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("treats a deleted latest selfie as authoritative instead of reviving older evidence", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    findFirstDocument.mockImplementation((args: {
      where?: { docType?: string; deletedAt?: null }
    }) => {
      if (args.where?.docType === "CREDIT_AGREEMENT") {
        return Promise.resolve(BOUND_AGREEMENT_DOCUMENT)
      }
      if (args.where?.docType === "SELFIE") {
        if ((args.where as { OR?: unknown }).OR) {
          // Blocking-candidate probe for the in-person route (its where DOES
          // filter deletedAt); the latest-attempt read below must not.
          return Promise.resolve(null)
        }
        expect(args.where).not.toHaveProperty("deletedAt")
        return Promise.resolve({
          ...PASSING_BIOMETRIC_DOCUMENT,
          deletedAt: new Date("2026-05-10T10:00:00.000Z"),
        })
      }
      return Promise.resolve({ id: "bank-doc-1" })
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: "document_deleted",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("rejects biometric evidence that belongs to the client's previous identity", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        idNumber: "9101015000085",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: "subject_identity_changed",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("re-checks biometric evidence inside the money transaction", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        kycStatus: "VERIFIED",
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    let selfieReads = 0
    findFirstDocument.mockImplementation((args: { where?: { docType?: string } }) => {
      if (args.where?.docType === "CREDIT_AGREEMENT") {
        return Promise.resolve(BOUND_AGREEMENT_DOCUMENT)
      }
      if (args.where?.docType === "DEBIT_MANDATE") {
        return Promise.resolve(BOUND_DEBIT_MANDATE_DOCUMENT)
      }
      if (args.where?.docType === "SELFIE") {
        if ((args.where as { OR?: unknown }).OR) {
          // Blocking-candidate probe for the in-person route — not one of
          // the latest-attempt reads this test is counting.
          return Promise.resolve(null)
        }
        selfieReads += 1
        return Promise.resolve(selfieReads === 1
          ? PASSING_BIOMETRIC_DOCUMENT
          : {
              ...PASSING_BIOMETRIC_DOCUMENT,
              extractionResult: {
                ...PASSING_BIOMETRIC_DOCUMENT.extractionResult,
                isLive: { value: false },
              },
            })
      }
      return Promise.resolve({ id: "bank-doc-1" })
    })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: "vlm_liveness_failed",
    }))
    expect(selfieReads).toBe(2)
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("books the final agreement dates instead of rebasing again at payout", async () => {
    const quoteStart = new Date("2026-05-04T00:00:00.000Z")
    const agreementStart = new Date("2026-05-10T00:00:00.000Z")
    const quoteFingerprint = "quote-contract-schedule"
    const quotedCalculator = {
      ...passingContract.calculator,
      startDate: quoteStart.toISOString(),
      schedule: passingContract.calculator.schedule.map((item) => ({
        ...item,
        dueDate: "2026-06-04T00:00:00.000Z",
      })),
      contractFingerprint: quoteFingerprint,
    }
    const rebasedContract = {
      ...passingContract,
      version: "affordability-contract-v2",
      establishedAt: agreementStart.toISOString(),
      acceptedPasqContractFingerprint: quoteFingerprint,
      quotePresentedAt: quoteStart.toISOString(),
      quoteValidUntilDate: "2026-05-11",
      calculator: {
        ...quotedCalculator,
        startDate: agreementStart.toISOString(),
        schedule: quotedCalculator.schedule.map((item) => ({
          ...item,
          dueDate: "2026-06-10T00:00:00.000Z",
        })),
        contractFingerprint: "rebased-contract-schedule",
      },
    }
    readAffordabilitySnapshotStore.mockReturnValue({
      submission: {
        stage: "SUBMISSION",
        capturedAt: "2026-05-01T00:00:00.000Z",
      },
      contract: rebasedContract,
    })
    verifyStoredPasqBinding.mockReturnValue({
      ok: true,
      documentId: "pasq-doc-1",
      documentSha256: "d".repeat(64),
      evidence: {
        version: "pasq-v3",
        evidenceSha256: "e".repeat(64),
        calculator: quotedCalculator,
        creditLife: {
          election: "ACCEPTED",
          monthlyPremiumCents: 2_250,
          totalPremiumCents: 2_250,
        },
        billing: {
          version: "credit-life-billing-v1",
          collectionMethod: "INCLUDED_IN_LOAN_REPAYMENT",
          recurringPaymentCents: 557_250,
          totalRepayableCents: 557_250,
          schedule: [{
            installmentNo: 1,
            dueDate: "2026-06-04T00:00:00.000Z",
            principalDueCents: 500_000,
            interestDueCents: 50_000,
            baseFeesDueCents: 5_000,
            creditLifePremiumDueCents: 2_250,
            feesDueCents: 7_250,
            totalDueCents: 557_250,
            openingBalanceCents: 500_000,
            closingBalanceCents: 0,
          }],
        },
      },
    })
    approvalSnapshotMatches.mockReturnValue(passingApprovalSnapshotMatch)
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementGeneratedAt: agreementStart,
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const { loanCreate, scheduleCreateMany } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    const responseBody = await response.clone().json()
    expect(response.status, JSON.stringify(responseBody)).toBe(200)
    expect(creditBureauCheckFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        applicationId: "app-1",
        clientId: "client-1",
      }),
      select: expect.objectContaining({ subjectFingerprint: true }),
    }))
    expect(loanCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        agreementDocId: "agreement-doc-1",
        startDate: new Date("2026-05-10T12:00:00.000Z"),
        maturityDate: new Date("2026-06-10T00:00:00.000Z"),
        nextPaymentDate: new Date("2026-06-10T00:00:00.000Z"),
        interestRatePm: 0.05,
        interestModel: "FLAT",
        creditLifePremiums: 2_250,
        totalRepayable: 557_250,
        contractualTotalInterest: 50_000,
        contractualTotalRepayable: 557_250,
      }),
    })
    expect(scheduleCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        dueDate: new Date("2026-06-10T00:00:00.000Z"),
        creditLifePremiumDue: 2_250,
        feesDue: 7_250,
        totalDue: 557_250,
      })],
    })
    const createdLoan = loanCreate.mock.calls[0][0].data
    expect(createdLoan.startDate.getTime()).toBe(Date.now())
    expect(createdLoan.maturityDate).toEqual(
      new Date(rebasedContract.calculator.schedule[0].dueDate),
    )
    const documentLookups = findFirstDocument.mock.calls.map(
      ([args]) => args as { where: Record<string, unknown> },
    )
    const agreementLookups = documentLookups.filter(
      ({ where }) => where.docType === "CREDIT_AGREEMENT",
    )
    expect(agreementLookups).toHaveLength(2)
    expect(agreementLookups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        where: expect.objectContaining({
          id: "agreement-doc-1",
          contentSha256: AGREEMENT_PDF_SHA256,
        }),
      }),
    ]))
    expect(findManyDocuments).toHaveBeenCalledTimes(2)
    for (const [lookup] of findManyDocuments.mock.calls) {
      expect(lookup).toEqual(expect.objectContaining({
        where: expect.objectContaining({
          clientId: "client-1",
          deletedAt: null,
          docType: {
            in: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"],
          },
        }),
      }))
    }
  })

  it("rolls back when signed agreement bytes change after preflight", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    let agreementReads = 0
    readFile.mockImplementation((storagePath: string) => {
      if (storagePath === BOUND_DEBIT_MANDATE_DOCUMENT.storagePath) {
        return Promise.resolve(DEBIT_MANDATE_PDF)
      }
      agreementReads += 1
      return Promise.resolve(
        agreementReads === 1
          ? AGREEMENT_PDF
          : Buffer.from("%PDF-1.4 changed during payout"),
      )
    })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "agreement_document_bytes",
    }))
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("holds the shared approval-evidence locks through the money transaction", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    verifyLockedCurrentAffordabilityApproval.mockResolvedValue({
      ok: false,
      reason: "bureau_subject_changed",
    })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      affordabilitySnapshot: "bureau_subject_changed",
    }))
    expect(verifyLockedCurrentAffordabilityApproval).toHaveBeenCalledWith(
      expect.any(Object),
      { tenantId: "tenant-1", applicationId: "app-1" },
    )
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("blocks before payout when signed contract evidence is missing", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    readAffordabilitySnapshotStore.mockReturnValue({
      submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "contract_missing",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before payout when signed contract evidence fails integrity validation", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    affordabilityContractEvidenceIsIntact.mockReturnValue(false)

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "contract_changed",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks payout after the five-business-day quote window", async () => {
    const priorContract = {
      ...passingContract,
      establishedAt: "2026-05-01T12:00:00.000Z",
      calculator: {
        ...passingContract.calculator,
        startDate: "2026-05-01T12:00:00.000Z",
        schedule: passingContract.calculator.schedule.map((item) => ({
          ...item,
          dueDate: "2026-06-01T12:00:00.000Z",
        })),
      },
    }
    readAffordabilitySnapshotStore.mockReturnValue({
      submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
      contract: priorContract,
    })
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementGeneratedAt: new Date(priorContract.establishedAt),
      agreementSignedAt: new Date("2026-05-01T13:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "contract_expired",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks payout when below-MLE expenses have no documented justification", async () => {
    verifyCurrentAffordabilityApproval.mockReturnValueOnce({
      ok: false,
      reason: "mle_justification_missing",
    })
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        grossMonthlyIncome: 1_000_000,
        monthlyIncome: 900_000,
        monthlyExpenses: 0,
        expenseBreakdown: {
          id: "website-expense",
          updatedAt: new Date("2026-05-10T00:00:00.000Z"),
          housing: 0,
          transport: 0,
          food: 0,
          education: 0,
          insurance: 0,
          clothing: 0,
          entertainment: 0,
          medical: 0,
          other: 0,
          belowMleJustification: null,
        },
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "mle_justification_missing",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("requires the exact active signed agreement document before payout", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    findFirstDocument.mockResolvedValueOnce(null)

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain("signed credit-agreement document")
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("defaults auto-bundling off and audits the compliance containment", async () => {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    const { insurancePolicyCreate, auditLogCreate } = buildTxMock({
      agreementArtifactData: {
        ...DEFAULT_CREDIT_LIFE_ARTIFACT,
        creditLifeAutoBundleEligible: false,
      },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(200)
    expect(findFirstInsuranceProduct).not.toHaveBeenCalled()
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "INSURANCE_AUTOBUNDLE_SKIPPED",
        newValue: expect.objectContaining({ reason: "feature_disabled" }),
      }),
    }))
    expect(generateFaisDisclosurePdf).not.toHaveBeenCalled()
  })

  // Sibling of the sign route's ordering test. The contract gate inside the
  // money transaction and the Loan's own startDate must be ONE reading of the
  // clock. Read it twice and a payout begun at 23:59 SAST can be judged against
  // one SAST day and booked against the next -- and since the gate demands the
  // contract be acted on within its established SAST day, the second reading
  // makes the payout refuse itself. Mutation-verified below by moving the
  // reading back to where it used to be.
  //
  // A single frozen clock cannot detect this, so the clock is advanced across
  // the SAST midnight boundary by a mock the route calls after the evidence
  // check but before the booking.
  // The same-day rule is scoped to the repayment method. For a debit order the
  // gate forces payout onto the establishment day, so payoutShiftDays is always 0
  // and shiftToPayout is inert. For EFT it is live, and it is what holds the NCA s103 rate cap — without it a
  // two-day-late payout gives the consumer 28 days of credit at 30 days of
  // interest, which is 5.36% a month against a 5% cap.
  const laggedPayout = async (repaymentMethod: "EFT" | "DEBIT_ORDER") => {
    // Contract established 2026-05-10; payout two SAST days later.
    vi.setSystemTime(new Date("2026-05-12T12:00:00.000Z"))
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      repaymentMethod,
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    const tx = buildTxMock({})
    const response = await POST(makeRequest(), ctx)
    return { response, ...tx }
  }

  it("shifts every booked due date by the payout lag for an EFT loan", async () => {
    const { response, loanCreate, scheduleCreateMany } = await laggedPayout("EFT")

    const body = await response.clone().json()
    expect(response.status, JSON.stringify(body)).toBe(200)

    // The signed contract's only instalment falls on 2026-06-10. Payout is two
    // days late, so the booked date moves to 2026-06-12 — the consumer keeps the
    // full 30 days they were quoted rather than losing two of them.
    const booked = loanCreate.mock.calls[0][0].data
    expect(booked.startDate).toEqual(new Date("2026-05-12T12:00:00.000Z"))
    expect(booked.maturityDate).toEqual(new Date("2026-06-12T00:00:00.000Z"))
    expect(scheduleCreateMany.mock.calls[0][0].data[0].dueDate)
      .toEqual(new Date("2026-06-12T00:00:00.000Z"))

    // Dates move; money does not. The rand figures are bound to the acknowledged
    // PASQ billing ledger and must be untouched by the shift.
    expect(booked.principal).toBe(500_000)
    expect(booked.totalInterest).toBe(50_000)
  })

  it("refuses the same lagged payout for a DEBIT_ORDER loan", async () => {
    // Its mandate authorises collection on the contract's dates and cannot be
    // amended, so a debit order still has to pay out on the established day.
    const { response, loanCreate } = await laggedPayout("DEBIT_ORDER")
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).not.toBe(200)
    expect(JSON.stringify(body)).toMatch(/contract_expired|unchanged_affordability|no longer current/i)
    // The decisive assertion: no loan was booked.
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("books the payout at the instant the contract gate approved, not a later one", async () => {
    // 23:59:30 SAST on the contract's established day (establishedAt is
    // 2026-05-10T00:00:00Z), so the gate passes.
    vi.setSystemTime(new Date("2026-05-10T21:59:30.000Z"))
    expect(southAfricanCalendarDate(new Date("2026-05-10T21:59:30.000Z")))
      .toBe(southAfricanCalendarDate(new Date(passingContract.establishedAt)))

    // The route verifies the PASQ artifact twice: once before the transaction
    // and once under lock. Only the second call sits inside the window between
    // where the payout instant is stamped now and where it used to be stamped,
    // so only the second call may advance the clock -- advancing on the first
    // would move the reading for BOTH the fixed and the broken shape and prove
    // nothing.
    let pasqArtifactCalls = 0
    verifyPasqDocumentArtifact.mockImplementation(async () => {
      pasqArtifactCalls += 1
      if (pasqArtifactCalls === 2) {
        // 00:01:30 SAST the following day -- a day the gate never approved.
        vi.setSystemTime(new Date("2026-05-10T22:01:30.000Z"))
      }
      return { ok: true, document: {}, bytes: Buffer.from("%PDF-1.4 PASQ") }
    })
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    const body = await response.clone().json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    // Confirms the advance really happened, so this cannot pass vacuously.
    expect(southAfricanCalendarDate(new Date())).not.toBe(
      southAfricanCalendarDate(new Date(passingContract.establishedAt)),
    )
    const bookedStartDate = loanCreate.mock.calls[0][0].data.startDate as Date
    expect(southAfricanCalendarDate(bookedStartDate)).toBe(
      southAfricanCalendarDate(new Date(passingContract.establishedAt)),
    )
  })

  it("bundles a credit-life policy inside the disburse tx only when explicitly enabled", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const {
      insurancePolicyCreate,
      loanCreate,
      auditLogCreate,
      queryRaw,
      executeRawUnsafe,
      complianceRecordFindFirst,
      insuranceProductFindFirst,
    } = buildTxMock({})

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(insurancePolicyCreate).toHaveBeenCalledOnce()
    expect(queryRaw).toHaveBeenCalledWith(expect.objectContaining({
      values: [
        "tenant-1",
        "client-1",
        "agreement-doc-1",
        AGREEMENT_PDF_SHA256,
        "credit-agreement-app-1.pdf",
        BOUND_DEBIT_MANDATE_DOCUMENT.id,
        DEBIT_MANDATE_PDF_SHA256,
      ],
    }))
    const documentLockSql = (queryRaw.mock.calls[0][0].strings as readonly string[]).join(" ")
    expect(documentLockSql).toMatch(
      /SELFIE[\s\S]*BANK_STATEMENT[\s\S]*CREDIT_AGREEMENT[\s\S]*DEBIT_MANDATE[\s\S]*FOR SHARE/,
    )
    expect(documentLockSql.indexOf('"deletedAt" IS NULL')).toBeGreaterThan(
      documentLockSql.indexOf("SELFIE"),
    )
    expect((queryRaw.mock.calls[1][0].strings as readonly string[]).join(" ")).toMatch(
      /ComplianceRecord[\s\S]*CREDIT_AGREEMENT_ARTIFACT[\s\S]*FOR SHARE/,
    )
    expect(complianceRecordFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: "tenant-1",
        type: "AGREEMENT_ARTIFACT",
        referenceId: "app-1",
        status: "COMPLETED",
        completedAt: { not: null },
        AND: expect.arrayContaining([
          { data: { path: ["kind"], equals: "CREDIT_AGREEMENT_ARTIFACT" } },
          { data: { path: ["lifecycle"], equals: "COMPLETED" } },
          { data: { path: ["applicationId"], equals: "app-1" } },
        ]),
      }),
    }))
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      loanCreate.mock.invocationCallOrder[0],
    )
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      loanCreate.mock.invocationCallOrder[0],
    )
    expect(executeRawUnsafe).toHaveBeenCalledOnce()
    expect(executeRawUnsafe).toHaveBeenCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
    expect(auditLogCreate.mock.invocationCallOrder.at(-1)).toBeLessThan(
      executeRawUnsafe.mock.invocationCallOrder[0],
    )

    const createCall = insurancePolicyCreate.mock.calls[0][0]
    expect(createCall.data.policySource).toBe("BUNDLED_CREDIT_AGREEMENT")
    expect(createCall.data.faisDisclosureAt).toBeNull()
    expect(createCall.data.linkedLoanId).toBe("loan-1")

    // the bundle records the underwriter + commission, with the premium
    // capped at the Credit Life Regs 2017 Reg 3(1) ceiling of R4.50 per R1 000
    // of the deferred amount per month. R5,000 principal → premium R22.50;
    // commission = 22.50 × 0.15 = R3.38 (rounded). insurerId flows from the
    // product. PPR is NOT stamped in the policy create — it is
    // stamped in the post-commit update only once the disclosure exists.
    expect(createCall.data.premiumAmount).toBe(22.5)
    expect(createCall.data.insurerId).toBe("insurer-1")
    expect(createCall.data.commissionRate).toBe(0.15)
    expect(createCall.data.commissionAmount).toBe(3.38)
    expect(createCall.data.pprIssuedAt).toBeUndefined()
    expect(insuranceProductFindFirst).toHaveBeenCalledWith({
      where: {
        id: CREDIT_LIFE_DISCLOSURE.productId,
        tenantId: "tenant-1",
        name: CREDIT_LIFE_DISCLOSURE.productName,
        type: "CREDIT_LIFE",
        active: true,
        insurerId: CREDIT_LIFE_DISCLOSURE.insurerId,
        insurer: {
          is: {
            id: CREDIT_LIFE_DISCLOSURE.insurerId,
            tenantId: "tenant-1",
            name: CREDIT_LIFE_DISCLOSURE.insurerName,
            active: true,
          },
        },
      },
      select: { id: true, insurerId: true, commissionRate: true },
    })
    const lockedOfferSql = queryRaw.mock.calls
      .map(([query]) => {
        const sql = query as { strings?: readonly string[] }
        return sql.strings?.join(" ") ?? String(query)
      })
      .find((sql) => sql.includes('FROM "InsuranceProduct"'))
    expect(lockedOfferSql).toContain(
      `product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"`,
    )
    expect(lockedOfferSql).toContain(`insurer."active" = TRUE`)
    expect(lockedOfferSql).toContain(`FOR SHARE OF product, insurer`)

    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "INSURANCE_POLICY_AUTOBUNDLED",
          entity: "InsurancePolicy",
          entityId: "pol-1",
        }),
      })
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "LOAN_CREATED",
          entity: "Loan",
          entityId: "loan-1",
          newValue: expect.objectContaining({
            reference: "LN-TESTREF",
            applicationId: "app-1",
            clientId: "client-1",
            productId: "prod-1",
            principal: 500000,
            totalInterest: 50000,
            initiationFee: 5000,
            serviceFees: 0,
            creditLifePremiums: 2250,
            totalRepayable: 557250,
            disbursementAmount: 500000,
            termDays: 30,
            interestRatePm: 0.05,
            interestModel: "FLAT",
            signedScheduleStartDate: "2026-05-10T00:00:00.000Z",
            startDate: "2026-05-10T12:00:00.000Z",
            agreementScheduleOffsetMs: 0,
            maturityDate: "2026-06-10T00:00:00.000Z",
            scheduleItems: 1,
          }),
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "LOAN_DISBURSED",
          entityId: "app-1",
        }),
      }),
    )
  })

  it("does not bundle when the signed agreement artifact did not bind credit life", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
      productType: "MICRO",
    })
    const { insurancePolicyCreate, auditLogCreate } = buildTxMock({
      agreementArtifactData: {
        ...DEFAULT_CREDIT_LIFE_ARTIFACT,
        creditLifeAutoBundleEligible: false,
      },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(200)
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "INSURANCE_AUTOBUNDLE_SKIPPED",
        newValue: expect.objectContaining({ reason: "agreement_not_bound" }),
      }),
    }))
  })

  it("blocks disbursement when the acknowledged application premium was changed", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      creditLifeMonthlyPremiumCents:
        DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeMonthlyPremiumCents - 1,
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
        productType: "MICRO",
      },
    })
    const { insurancePolicyCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_changed",
    }))
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
  })

  it("blocks disbursement when the signed artifact no longer matches the acknowledged offer", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
        productType: "MICRO",
      },
    })
    const { insurancePolicyCreate } = buildTxMock({
      agreementArtifactData: {
        ...DEFAULT_CREDIT_LIFE_ARTIFACT,
        creditLifeInsurerName: "Changed after signing",
      },
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "credit_life_agreement_evidence_changed",
    }))
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
  })

  it.each([
    ["is missing", { agreementArtifactMissing: true }],
    ["has no election", { agreementArtifactData: {} }],
    ["has a string election", { agreementArtifactData: { creditLifeAutoBundleEligible: "true" } }],
    ["has non-object data", { agreementArtifactData: "true" }],
  ] as const)("blocks disbursement when the completed agreement artifact %s", async (_label, artifact) => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
      productType: "MICRO",
    })
    const { insurancePolicyCreate } = buildTxMock(artifact)

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "credit_life_agreement_election_missing",
    }))
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("issues + tracks the FAIS/PPR disclosure for the bundled policy", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({})

    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)

    // A FAIS disclosure PDF was generated for the bundled policy and stored,
    // naming the tenant's own NCR and FSP numbers.
    expect(generateFaisDisclosurePdf).toHaveBeenCalledOnce()
    expect(generateFaisDisclosurePdf).toHaveBeenCalledWith(expect.objectContaining({
      lender: expect.objectContaining({ ncrNumber: "NCRCP99999", fspNumber: "12345" }),
    }))
    expect(saveFile).toHaveBeenCalledOnce()
    const docCall = createClientDocument.mock.calls[0][0]
    expect(docCall.data.docType).toBe("OTHER")
    expect(docCall.data.fileName).toContain("fais-disclosure")

    // The policy is stamped: faisDisclosureAt + faisDisclosurePdfUrl + pprIssuedAt,
    // and pprIssuedAt is set ONLY because the artifact now exists.
    const polUpdate = updateInsurancePolicy.mock.calls[0][0]
    expect(polUpdate.data.faisDisclosureAt).toBeInstanceOf(Date)
    expect(polUpdate.data.pprIssuedAt).toBeInstanceOf(Date)
    expect(polUpdate.data.faisDisclosurePdfUrl).toBe("/api/documents/disc-doc-1/view")

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_PPR_ISSUED", entityId: "pol-1" })
    )
  })

  it("does not roll back the disburse if FAIS/PPR disclosure issuance fails", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({})
    // Disclosure generation blows up — the disburse must still succeed (200),
    // the loan + bound cover stay valid, and pprIssuedAt is NOT stamped.
    generateFaisDisclosurePdf.mockRejectedValueOnce(new Error("pdf boom"))

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(updateInsurancePolicy).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_PPR_ISSUE_FAILED" })
    )
  })

  it("leaves the FAIS disclosure unissued, and still disburses, when the lender identity is not configured", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({})
    const { LenderIdentityError } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    getLenderIdentityMock.mockRejectedValue(new LenderIdentityError(["fscaNumber"]))

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(generateFaisDisclosurePdf).not.toHaveBeenCalled()
    expect(updateInsurancePolicy).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_PPR_ISSUE_FAILED" })
    )
  })

  it("rolls back the disburse if the bundle insurancePolicy.create throws", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const bundleError = new Error("simulated insurance.create DB failure")
    const { auditLogCreate } = buildTxMock({ bundlePolicyCreateThrows: bundleError })

    const res = await POST(makeRequest(), ctx)

    // Outer catch returns 500 — disburse blocked, no AUTOBUNDLED audit fired
    expect(res.status).toBe(500)
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("fails closed when the mandatory disbursement audit cannot be written", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const {
      loanCreate,
      scheduleCreateMany,
      insurancePolicyCreate,
      auditLogCreate,
    } = buildTxMock({
      auditLogCreateThrows: new Error("audit unavailable"),
      auditLogCreateThrowsForAction: "LOAN_DISBURSED",
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(500)
    expect(loanCreate).toHaveBeenCalledOnce()
    expect(scheduleCreateMany).toHaveBeenCalledOnce()
    expect(insurancePolicyCreate).toHaveBeenCalledOnce()
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_DISBURSED" }),
    }))
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("fails closed when the mandatory loan-created audit cannot be written", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    })
    const { auditLogCreate } = buildTxMock({
      auditLogCreateThrows: new Error("audit unavailable"),
      auditLogCreateThrowsForAction: "LOAN_CREATED",
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(500)
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_CREATED" }),
    }))
    expect(auditLogCreate).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_DISBURSED" }),
    }))
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("throws inside the tx and maps to 409 when a concurrent disburse already claimed the application", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const { insurancePolicyCreate, auditLogCreate } = buildTxMock({ applicationUpdateManyCount: 0 })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    // The tx rolled back before reaching the bundle — no bundle or disburse
    // audit fired, i.e. no effect of the queued Loan/schedule/bundle creates
    // is observable.
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("honours signed cover even when the runtime flag is disabled before disbursement", async () => {
    delete process.env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
      productType: "MICRO",
    })
    const { insurancePolicyCreate } = buildTxMock({
      agreementArtifactData: {
        ...DEFAULT_CREDIT_LIFE_ARTIFACT,
        creditLifeAutoBundleEligible: true,
      },
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(insurancePolicyCreate).toHaveBeenCalledOnce()
  })

  it("blocks disbursement when signed cover has no configured CREDIT_LIFE product", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const { insurancePolicyCreate } = buildTxMock({ product: null })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "credit_life_product_unavailable",
    }))
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("locks accepted cover to the same active tenant insurer before payout", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
      productType: "MICRO",
    })
    const { insuranceProductFindFirst } = buildTxMock({})

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(insuranceProductFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeProductId,
        tenantId: "tenant-1",
        name: DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeProductName,
        active: true,
        insurerId: DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeInsurerId,
        insurer: {
          is: {
            id: DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeInsurerId,
            tenantId: "tenant-1",
            name: DEFAULT_CREDIT_LIFE_APPLICATION.creditLifeInsurerName,
            active: true,
          },
        },
      }),
    }))
  })

  function configureBelowThresholdDisbursement() {
    const creditLifeEvidence = buildCreditLifeTestEvidence(50000, 14)
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 50000, // R500 — below the R1,000 threshold (100000 cents)
      appliedTermDays: 14,
      clientId: "client-1",
      productId: "prod-1",
      ...creditLifeEvidence.application,
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    approvalSnapshotMatches.mockReturnValue({
      ...passingApprovalSnapshotMatch,
      snapshot: {
        ...passingApprovalSnapshotMatch.snapshot,
        inputs: {
          ...passingApprovalSnapshotMatch.snapshot.inputs,
          principalCents: 50000,
          termDays: 14,
        },
        calculator: {
          ...passingApprovalSnapshotMatch.snapshot.calculator,
          principalCents: 50000,
          totalInterestCents: 5000,
          initiationFeeCents: 5000,
          totalRepayableCents: 60000,
          disbursementAmountCents: 50000,
          recurringInstalmentCents: 60000,
          schedule: [{
            ...passingApprovalSnapshotMatch.snapshot.calculator.schedule[0],
            principalDueCents: 50000,
            interestDueCents: 5000,
            feesDueCents: 5000,
            totalDueCents: 60000,
            openingBalanceCents: 50000,
          }],
        },
      },
    })
    readAffordabilitySnapshotStore.mockReturnValue({
      submission: { stage: "SUBMISSION", capturedAt: "2026-05-01T00:00:00.000Z" },
      contract: {
        ...passingContract,
        calculator: {
          ...passingContract.calculator,
          principalCents: 50000,
          totalInterestCents: 5000,
          initiationFeeCents: 5000,
          totalRepayableCents: 60000,
          disbursementAmountCents: 50000,
          recurringInstalmentCents: 60000,
          schedule: [{
            ...passingContract.calculator.schedule[0],
            principalDueCents: 50000,
            interestDueCents: 5000,
            feesDueCents: 5000,
            totalDueCents: 60000,
            openingBalanceCents: 50000,
          }],
        },
      },
    })
    return creditLifeEvidence
  }

  it("does NOT attempt a bundle when applied amount is below R1,000", async () => {
    const creditLifeEvidence = configureBelowThresholdDisbursement()
    const { insurancePolicyCreate, auditLogCreate } = buildTxMock({
      agreementArtifactData: creditLifeEvidence.artifact,
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).toHaveBeenCalledTimes(3)
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_CREATED", entityId: "loan-1" }),
    }))
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_DISBURSED" }),
    }))
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "INSURANCE_AUTOBUNDLE_SKIPPED",
        newValue: expect.objectContaining({ reason: "below_threshold" }),
      }),
    }))
  })

  it("fails closed when the below-threshold insurance outcome audit cannot be written", async () => {
    const creditLifeEvidence = configureBelowThresholdDisbursement()
    const { insurancePolicyCreate, auditLogCreate } = buildTxMock({
      auditLogCreateThrows: new Error("audit unavailable"),
      auditLogCreateThrowsForAction: "INSURANCE_AUTOBUNDLE_SKIPPED",
      agreementArtifactData: creditLifeEvidence.artifact,
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(500)
    expect(insurancePolicyCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "LOAN_DISBURSED" }),
    }))
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "INSURANCE_AUTOBUNDLE_SKIPPED",
        newValue: expect.objectContaining({ reason: "below_threshold" }),
      }),
    }))
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("refuses to disburse when the credit agreement is unsigned (upstream gate)", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: null,
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(422)
    // We never even open the disburse tx
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before payout when immutable submission evidence is missing", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      clientId: "client-1",
    })
    readAffordabilitySnapshotStore.mockReturnValue({ contract: passingContract })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "submission_missing",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before payout when immutable submission evidence fails integrity validation", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      clientId: "client-1",
    })
    affordabilityDecisionSnapshotIsIntact.mockReturnValueOnce(false)

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "submission_changed",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before payout when approval affordability inputs changed", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      totalExistingDebt: 30000,
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [{
        sourceId: "application-debt-1",
        provider: "Bank A",
        type: "PERSONAL_LOAN",
        balance: 400000,
        monthlyInstalment: 30000,
        notes: "Declared",
      }],
      affordabilityResult: { schemaVersion: 1 },
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [{
          id: "client-debt-1",
          creditProvider: "Bank A",
          accountType: "PERSONAL_LOAN",
          outstandingBalance: 400000,
          monthlyInstalment: 30000,
          notes: "Master record",
        }],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    approvalSnapshotMatches.mockReturnValueOnce({ ok: false, reason: "changed" })

    const response = await POST(makeRequest(), ctx)

    expect(verifyCurrentAffordabilityApproval).toHaveBeenCalledWith(expect.objectContaining({
      application: expect.objectContaining({
        affordabilityResult: { schemaVersion: 1 },
        existingDebtObligations: [expect.objectContaining({
          sourceId: "application-debt-1",
          provider: "Bank A",
        })],
      }),
      bureauCheck: expect.objectContaining({ id: "bc-1" }),
      tenantConfig: expect.objectContaining({ bureauMinScore: 450 }),
    }))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "changed",
      error: expect.stringContaining("inputs changed after approval"),
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it.each([
    [null, "null"],
    ["corrupt", "a string"],
    [{ monthlyInstalment: 250000, balance: 1000000 }, "an object"],
  ])("blocks payout when persisted debt evidence is %s (%s)", async (existingDebtObligations, _description) => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      approvedAmount: null,
      approvedTermDays: null,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations,
      affordabilityResult: { schemaVersion: 3 },
      client: {
        grossMonthlyIncome: 1_600_000,
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        expenseBreakdown: null,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    verifyCurrentAffordabilityApproval.mockReturnValueOnce({
      ok: false,
      reason: "debt_evidence_invalid",
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "debt_evidence_invalid",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks before payout when stored approval says affordability failed", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      approvedAmount: null,
      approvedTermDays: null,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      affordabilityResult: { schemaVersion: 1 },
      bureauOverrideReason: "Reasoned bureau exception with supporting evidence",
      bureauOverrideById: "officer-1",
      bureauOverrideAt: new Date("2026-05-01T07:00:00Z"),
      client: {
        grossMonthlyIncome: 1_600_000,
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        expenseBreakdown: null,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    approvalSnapshotMatches.mockReturnValueOnce({
      ...passingApprovalSnapshotMatch,
      snapshot: {
        ...passingApprovalSnapshotMatch.snapshot,
        outcome: { isAffordable: false },
      },
    })
    verifyCurrentAffordabilityApproval.mockReturnValueOnce({
      ok: false,
      reason: "affordability_failed",
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "affordability_failed",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("rechecks approval evidence inside the serializable transaction and blocks a mid-flight change", async () => {
    const application = {
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      updatedAt: new Date("2026-05-01T09:00:00Z"),
      agreementSignedAt: new Date("2026-05-01T08:00:00Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      affordabilityResult: { schemaVersion: 2 },
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    }
    findUniqueApplication.mockResolvedValue(application)
    approvalSnapshotMatches.mockReturnValueOnce(passingApprovalSnapshotMatch)
    verifyLockedCurrentAffordabilityApproval.mockResolvedValueOnce({
      ok: false,
      reason: "changed",
    })
    const { loanCreate, auditLogCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "changed",
      error: expect.stringContaining("no funds moved"),
    }))
    expect(verifyCurrentAffordabilityApproval).toHaveBeenCalledOnce()
    expect(verifyLockedCurrentAffordabilityApproval).toHaveBeenCalledOnce()
    expect(loanCreate).not.toHaveBeenCalled()
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("rolls back if the signed agreement document disappears inside the transaction", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    let agreementReads = 0
    findFirstDocument.mockImplementation((args: { where?: { docType?: string } }) => {
      if (args.where?.docType === "CREDIT_AGREEMENT") {
        agreementReads += 1
        return Promise.resolve(
          agreementReads === 1 ? BOUND_AGREEMENT_DOCUMENT : null,
        )
      }
      if (args.where?.docType === "DEBIT_MANDATE") {
        return Promise.resolve(BOUND_DEBIT_MANDATE_DOCUMENT)
      }
      if (args.where?.docType === "SELFIE") {
        return Promise.resolve(PASSING_BIOMETRIC_DOCUMENT)
      }
      return Promise.resolve({ id: "bank-doc-1" })
    })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "agreement_document",
    }))
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("rolls back if the verified bank statement disappears inside the transaction", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    findManyDocuments
      .mockResolvedValueOnce(VERIFIED_CORE_DOCUMENTS)
      .mockResolvedValueOnce(
        VERIFIED_CORE_DOCUMENTS.filter(({ docType }) => docType !== "BANK_STATEMENT"),
      )
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "composite_kyc",
      biometricEvidence: null,
      missingDocs: ["BANK_STATEMENT"],
    }))
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("forbids request-time payout bank overrides even when AVS is enabled", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    tenantConfigFindUnique.mockResolvedValueOnce({ collectionsEngineEnabled: true })
    const { loanCreate } = buildTxMock({})

    const response = await POST(makeRequest({
      bank: "Capitec",
      accountNo: "99999",
      branchCode: "470010",
      accountType: "SAVINGS",
      overrideProof: "Verified alternate statement",
    }), ctx)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/overridden bank details/i)
    expect(avsCheckFindFirst).not.toHaveBeenCalled()
    expect(prismaTransaction).not.toHaveBeenCalled()
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("disburses an EFT-approved loan with verified banking and no debit mandate", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      repaymentMethod: "EFT",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    const { loanCreate, auditLogCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(200)
    expect(verifyCurrentStoredDebitMandate).not.toHaveBeenCalled()
    expect(findVerifiedBankStatementForMandate).toHaveBeenCalledTimes(2)
    expect(loanCreate).toHaveBeenCalledOnce()
    expect(auditLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "LOAN_DISBURSED",
        newValue: expect.objectContaining({
          repaymentMethod: "EFT",
          bankStatementDocumentId: "bank-doc-1",
        }),
      }),
    }))
  })

  it("returns the distinct verified-banking 422 when mandate banking evidence is absent", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: null,
        bankAccountNumber: null,
        bankBranchCode: null,
        accountType: null,
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    verifyCurrentStoredDebitMandate.mockResolvedValue({
      ok: false,
      reason: "bank_details_incomplete",
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "verified_banking",
      debitMandateEvidence: "bank_details_incomplete",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("returns the distinct signed-mandate 422 when authority is unsigned", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-10T01:00:00.000Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: {
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    })
    verifyCurrentStoredDebitMandate.mockResolvedValue({
      ok: false,
      reason: "signature_missing",
    })

    const response = await POST(makeRequest(), ctx)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      disbursementPrecondition: "signed_debit_mandate",
      debitMandateEvidence: "signature_missing",
    }))
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("blocks when banking details change after the customer signs the mandate", async () => {
    const initialApplication = {
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      updatedAt: new Date("2026-05-01T09:00:00Z"),
      agreementSignedAt: new Date("2026-05-01T08:00:00Z"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      initiationFeePayment: "DEFERRED",
      existingDebtObligations: [],
      affordabilityResult: { schemaVersion: 2 },
      client: {
        monthlyIncome: 1_500_000,
        monthlyExpenses: 800_000,
        debtObligations: [],
        bankName: "FNB",
        bankAccountNumber: "12345",
        bankBranchCode: "250655",
        accountType: "SAVINGS",
      },
      product: {
        interestRatePm: 0.05,
        interestModel: "FLAT",
        initiationFeePct: 0.15,
        initiationFeeMax: 100000,
        monthlyServiceFee: 0,
      },
    }
    const transactionApplication = {
      ...initialApplication,
      updatedAt: new Date("2026-05-01T09:01:00Z"),
      client: {
        ...initialApplication.client,
        bankName: "ABSA",
        bankAccountNumber: "98765",
        bankBranchCode: "632005",
      },
    }
    findUniqueApplication
      .mockResolvedValueOnce(initialApplication)
      .mockResolvedValueOnce(transactionApplication)
    verifyCurrentStoredDebitMandate
      .mockResolvedValueOnce(VERIFIED_DEBIT_MANDATE)
      .mockResolvedValueOnce({ ok: false, reason: "evidence_invalid" })
    resolveDisbursementBankDetails
      .mockReturnValueOnce({
        bank: "FNB",
        accountNo: "12345",
        branchCode: "250655",
        accountType: "SAVINGS",
        bankRef: "REF-OLD",
        overrideUsed: false,
        overrideProof: null,
      })
      .mockReturnValueOnce({
        bank: "ABSA",
        accountNo: "98765",
        branchCode: "632005",
        accountType: "SAVINGS",
        bankRef: "REF-NEW",
        overrideUsed: false,
        overrideProof: null,
      })
    const { auditLogCreate } = buildTxMock({})

    const response = await POST(makeRequest(), ctx)

    expect({
      status: response.status,
      body: await response.json(),
    }).toEqual({
      status: 409,
      body: expect.objectContaining({
        affordabilitySnapshot: "debit_mandate_evidence_invalid",
      }),
    })
    expect(resolveDisbursementBankDetails).toHaveBeenCalledTimes(2)
    expect(resolveDisbursementBankDetails.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({
          bankName: "ABSA",
          bankAccountNumber: "98765",
          bankBranchCode: "632005",
        }),
      }),
    )
    expect(auditLogCreate).not.toHaveBeenCalled()
  })

  it("accrues a referral commission event when the borrower is referred", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const { referralEventCreate } = buildTxMock({
      referredClient: { referralCodeId: "code-1" },
      tenantConfig: { referralCommissionBps: 200 },
      referralCode: { id: "code-1", agentId: "agent-1", agent: { status: "ACTIVE", commissionBps: null } },
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(referralEventCreate).toHaveBeenCalledOnce()

    // principal 500000 cents @ 200 bps = 10000 cents (R100.00) commission.
    const eventCall = referralEventCreate.mock.calls[0][0]
    expect(eventCall.data).toMatchObject({
      eventType: "CONVERTED",
      commissionStatus: "PENDING",
      commissionCents: 10000,
      amountCents: 500000,
    })
    expect(eventCall.data.metadata).toMatchObject({ loanId: "loan-1" })
  })
})

describe("POST /api/applications/[id]/disburse — AVS gate behind collectionsEngineEnabled", () => {
  it("blocks disbursement when collectionsEngineEnabled and no passing AVS check", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({})
    tenantConfigFindUnique.mockResolvedValueOnce({ collectionsEngineEnabled: true })
    avsCheckFindFirst.mockResolvedValueOnce(null)

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/AVS/)
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it("disburses normally when the flag is off, with no AVS query at all", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({})
    // default mocks: flag off (hoisted default)

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(avsCheckFindFirst).not.toHaveBeenCalled()
  })

  it("blocks inside the transaction if AVS becomes mandatory after the pre-check", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    const { loanCreate } = buildTxMock({
      affordabilityTenantConfig: {
        collectionsEngineEnabled: true,
        ndiBufferPct: 110,
        bureauMinScore: 450,
        bureauBlockAdverse: false,
      },
    })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "avs",
      error: expect.stringContaining("no funds moved"),
    }))
    expect(loanCreate).not.toHaveBeenCalled()
  })

  it("disburses when flag on and latest AVS check passed for the current account", async () => {
    findUniqueApplication.mockResolvedValue({
      id: "app-1",
      tenantId: "tenant-1",
      status: "APPROVED",
      agreementSignedAt: new Date("2026-05-01"),
      appliedAmount: 500000,
      appliedTermDays: 30,
      clientId: "client-1",
      productId: "prod-1",
      client: { bankName: "FNB", bankAccountNumber: "12345", bankBranchCode: "250655", accountType: "SAVINGS" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
    productType: "MICRO",
    })
    buildTxMock({
      affordabilityTenantConfig: {
        collectionsEngineEnabled: true,
        ndiBufferPct: 110,
        bureauMinScore: 450,
        bureauBlockAdverse: false,
      },
    })
    tenantConfigFindUnique.mockResolvedValueOnce({ collectionsEngineEnabled: true })
    avsCheckFindFirst
      .mockResolvedValueOnce({
        clientId: "client-1",
        applicationId: "app-1",
        subjectFingerprint: "a".repeat(64),
        passed: true,
      })
      .mockResolvedValueOnce({
        clientId: "client-1",
        applicationId: "app-1",
        subjectFingerprint: "a".repeat(64),
        passed: true,
      })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(avsCheckFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: "tenant-1",
        clientId: "client-1",
        applicationId: "app-1",
      },
      select: expect.objectContaining({ subjectFingerprint: true }),
    }))
  })
})
