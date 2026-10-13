import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"

const requireApiRoleMock = vi.fn()
const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const clientDocumentFindManyMock = vi.fn()
const txDocumentUpdateManyMock = vi.fn()
const creditBureauCheckFindFirstMock = vi.fn()
const tenantConfigFindFirstMock = vi.fn()
const transactionMock = vi.fn()
const txUpdateManyMock = vi.fn()
const txCreditLifeOfferFindFirstMock = vi.fn()
const txAuditLogCreateMock = vi.fn()
const txExecuteRawUnsafeMock = vi.fn()
const triggerNotificationMock = vi.fn()
const evaluateAffordabilityGateMock = vi.fn()
const verifyLockedApprovalCandidateMock = vi.fn()
const verifyStoredPasqBindingMock = vi.fn()
const verifyPasqDocumentArtifactMock = vi.fn()
const runBureauReviewCheckMock = vi.fn()
const readCompositeKycStateMock = vi.fn()
const nonOverridableBlockMock = vi.fn()
const recomputeApplicationFlagsMock = vi.fn()
const txCheckFlagCountMock = vi.fn()
const txDocumentCountMock = vi.fn()
const txAnalysisCountMock = vi.fn()
const txPayslipFindManyMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/credit-checks/recompute", () => ({
  recomputeApplicationFlags: (...a: unknown[]) => recomputeApplicationFlagsMock(...a),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: (a: unknown) => findUniqueMock(a),
      updateMany: (a: unknown) => updateManyMock(a),
    },
    client: { findUnique: (a: unknown) => clientFindUniqueMock(a) },
    clientDocument: { findMany: (a: unknown) => clientDocumentFindManyMock(a) },
    creditBureauCheck: { findFirst: (a: unknown) => creditBureauCheckFindFirstMock(a) },
    tenantConfig: { findFirst: (a: unknown) => tenantConfigFindFirstMock(a) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => transactionMock(cb),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: (a: unknown) => triggerNotificationMock(a) }))
vi.mock("@/lib/kyc", () => ({ CORE_DOC_TYPES: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] }))
vi.mock("@/lib/compliance/bureau", () => ({ bureauStalenessCutoff: () => new Date("2020-01-01") }))
vi.mock("@/lib/decision/bureau-gate", () => ({
  evaluateBureauGate: () => ({ blocked: false }),
  nonOverridableBlock: (...args: unknown[]) => nonOverridableBlockMock(...args),
}))
vi.mock("@/lib/decision/affordability-gate", () => ({
  evaluateAffordabilityGate: (...args: unknown[]) => evaluateAffordabilityGateMock(...args),
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyLockedApprovalCandidate: (...args: unknown[]) =>
    verifyLockedApprovalCandidateMock(...args),
}))
// Only the stored-binding reader is stubbed. The credit-life billing helpers
// stay REAL: approval now derives the s.81 instalment from them rather than
// reading it off the quotation, so mocking them would make the figure the
// affordability gate tests unobservable — exactly the vacuousness that let the
// premium wiring go unverified before.
vi.mock("@/lib/compliance/pasq", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance/pasq")>()),
  verifyStoredPasqBinding: (...args: unknown[]) =>
    verifyStoredPasqBindingMock(...args),
}))
vi.mock("@/lib/compliance/pasq-document.server", () => ({
  verifyPasqDocumentArtifact: (...args: unknown[]) =>
    verifyPasqDocumentArtifactMock(...args),
}))
vi.mock("@/lib/compliance/bureau-review", () => ({
  runBureauReviewCheck: (args: unknown) => runBureauReviewCheckMock(args),
}))
vi.mock("@/lib/kyc/document-state", () => ({
  readCompositeKycState: (...args: unknown[]) => readCompositeKycStateMock(...args),
}))
vi.mock("@/lib/loan-calculator", () => ({
  calculateLoan: () => ({
    principal: 500000,
    totalInterest: 50000,
    initiationFee: 75000,
    serviceFees: 0,
    totalRepayable: 625000,
    disbursementAmount: 500000,
    monthlyInstalment: 1000,
    schedule: [{
      installmentNo: 1,
      dueDate: new Date("2026-08-17T12:00:00.000Z"),
      principalDue: 500000,
      interestDue: 50000,
      feesDue: 75000,
      totalDue: 625000,
      openingBalance: 500000,
      closingBalance: 0,
    }],
  }),
}))

import {
  createSubmissionAffordabilitySnapshot,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }

function makeReq(fields: Record<string, string>) {
  const requestFields =
    fields.action === "approve" && !Object.hasOwn(fields, "repaymentMethod")
      ? { ...fields, repaymentMethod: "EFT" }
      : fields
  const form = new FormData()
  for (const [k, v] of Object.entries(requestFields)) form.append(k, v)
  return new NextRequest("http://x/api/applications/app-1/decide", {
    method: "POST",
    body: form,
  })
}

const validSubmissionAffordabilityResult = withAffordabilitySnapshot(
  null,
  createSubmissionAffordabilitySnapshot({
    capturedAt: new Date("2026-07-18T11:47:00Z"),
    capturedById: "client-user-1",
    client: {
      grossMonthlyIncome: 1_100_000,
      monthlyIncome: 1_000_000,
      monthlyExpenses: 500_000,
      expenseBreakdown: {
        id: "expense-1",
        updatedAt: new Date("2026-07-18T11:30:00Z"),
        housing: 200_000,
        transport: 75_000,
        food: 125_000,
        education: 0,
        insurance: 25_000,
        clothing: 25_000,
        entertainment: 0,
        medical: 25_000,
        other: 25_000,
        belowMleJustification: null,
      },
    },
    applicationDebts: [{
      sourceId: "app-debt-1",
      provider: "Bank A",
      type: "PERSONAL_LOAN",
      balance: 400_000,
      monthlyInstalment: 25_000,
      notes: "Declared",
    }],
    clientDebts: [{
      id: "client-debt-1",
      creditProvider: "Bank A",
      accountType: "PERSONAL_LOAN",
      outstandingBalance: 400_000,
      monthlyInstalment: 25_000,
      notes: "Client master",
    }],
    application: {
      appliedAmount: 500_000,
      appliedTermDays: 30,
      productId: "product-1",
      initiationFeePayment: "DEFERRED",
    },
    product: {
      productType: "MICRO",
      interestRatePm: 0.05,
      interestModel: "FLAT",
      initiationFeeModel: "FLAT_PCT" as const,
      initiationFeePct: 0.15,
      initiationFeeMax: 100_000,
      monthlyServiceFee: 0,
    },
  }),
)

const tamperedSubmissionAffordabilityResult = structuredClone(
  validSubmissionAffordabilityResult,
)
if (tamperedSubmissionAffordabilityResult.submission) {
  tamperedSubmissionAffordabilityResult.submission.inputs.monthlyExpensesCents += 1
}

const underReviewApplication = {
  id: "app-1",
  status: "UNDER_REVIEW",
  updatedAt: new Date("2026-07-18T12:00:00Z"),
  submittedAt: new Date("2026-07-18T11:47:00Z"),
  bureauReviewGeneration: "review-generation-1",
  clientId: "client-1",
  productId: "product-1",
  appliedAmount: 500000,
  appliedTermDays: 30,
  approvedAmount: null,
  approvedTermDays: null,
  totalExistingDebt: null,
  initiationFeePayment: "DEFERRED",
  creditLifeElection: "DECLINED",
  creditLifeProductId: "credit-life-1",
  creditLifeProductName: "Acme Credit Life",
  creditLifeInsurerId: "insurer-1",
  creditLifeInsurerName: "Test Life",
  creditLifeMonthlyPremiumCents: 2250,
  creditLifeDisclosureVersion: "credit-life-election-v1",
  creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
    version: "credit-life-election-v1",
    election: "DECLINED",
    principalCents: 500000,
    termDays: 30,
    monthlyPremiumCents: 2250,
    productId: "credit-life-1",
    productName: "Acme Credit Life",
    insurerId: "insurer-1",
    insurerName: "Test Life",
  }),
  creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T11:44:00Z"),
  creditLifeDisclosureAcknowledgedBy: "client-user-1",
  pasqVersion: "pasq-v3",
  pasqGeneratedAt: new Date("2026-07-18T11:45:00Z"),
  pasqDocumentId: "pasq-doc-1",
  pasqDocumentSha256: "d".repeat(64),
  pasqEvidence: { version: "pasq-v3" },
  pasqEvidenceSha256: "e".repeat(64),
  pasqAcknowledgedAt: new Date("2026-07-18T11:45:00Z"),
  pasqAcknowledgedBy: "client-user-1",
  pasqAcknowledgedSha256: "d".repeat(64),
  approvedPasqDocumentSha256: null,
  clientAffordabilityDeclaredAt: new Date("2026-07-18T11:46:00Z"),
  recklessLendingAssessed: true,
  recklessLendingAssessedAt: new Date("2026-07-18T11:50:00Z"),
  recklessLendingAssessedById: "u1",
  existingDebtObligations: [{
    sourceId: "app-debt-1",
    provider: "Bank A",
    type: "PERSONAL_LOAN",
    balance: 400000,
    monthlyInstalment: 25000,
    notes: "Declared",
  }],
  affordabilityResult: validSubmissionAffordabilityResult,
  product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeePct: 0.15, initiationFeeMax: 100000, monthlyServiceFee: 0 },
  client: {
    id: "client-1",
    idNumber: "9001016000082",
    firstName: "A",
    lastName: "B",
    gender: "MALE",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    kycStatus: "VERIFIED",
    kycVerifiedAt: new Date("2026-07-18T11:00:00.000Z"),
    kycVerifiedById: "officer-1",
    kycVerificationMethod: "PHYSICAL",
    grossMonthlyIncome: 1_100_000,
    monthlyIncome: 1000000,
    monthlyExpenses: 500000,
    expenseBreakdown: {
      id: "expense-1",
      updatedAt: new Date("2026-07-18T11:30:00Z"),
      housing: 200000,
      transport: 75000,
      food: 125000,
      education: 0,
      insurance: 25000,
      clothing: 25000,
      entertainment: 0,
      medical: 25000,
      other: 25000,
      belowMleJustification: null,
    },
    debtObligations: [{
      id: "client-debt-1",
      creditProvider: "Bank A",
      accountType: "PERSONAL_LOAN",
      outstandingBalance: 400000,
      monthlyInstalment: 25000,
      notes: "Client master",
    }],
  },
}

const passingBureauCheck = {
  id: "bureau-1",
  clientId: "client-1",
  subjectFingerprint: "a".repeat(64),
  provider: "experian",
  createdAt: new Date("2026-07-18T11:00:00Z"),
  score: 600,
  riskGrade: "LOW",
  unscoreable: false,
  hasAdverse: false,
  deceased: false,
  underDebtReview: false,
  hasJudgement: false,
  hasNotice: false,
  obligations: { totalMonthly: 10000 },
}

const approvedApplication = {
  ...underReviewApplication,
  status: "APPROVED",
  repaymentMethod: "EFT",
  updatedAt: new Date("2026-07-18T13:00:00Z"),
  approvedById: "u1",
  approvedAt: new Date("2026-07-18T12:30:00Z"),
  approvedAmount: 500000,
  approvedTermDays: 30,
  approvedRate: 0.05,
  affordabilityResult: {
    schemaVersion: 3,
    approval: {
      stage: "APPROVAL",
      policyVersion: "approval-ndi-v3",
      decisionFingerprint: "prior-approval",
    },
  },
  agreementGeneratedAt: new Date("2026-07-18T12:35:00Z"),
  agreementDocumentId: "agreement-doc-1",
  agreementDocumentSha256: "a".repeat(64),
  agreementSignedAt: new Date("2026-07-18T12:40:00Z"),
  agreementSignedMethod: "DIGITAL",
  agreementSignedByIp: "127.0.0.1",
  agreementSignedByUserId: "client-user-1",
  agreementSignatureData: "data:image/png;base64,c2lnbmF0dXJl",
  pasqAcknowledgedAt: new Date("2026-07-18T12:36:00Z"),
  pasqAcknowledgedBy: "client-user-1",
  clientAffordabilityDeclaredAt: new Date("2026-07-18T12:37:00Z"),
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyStoredPasqBindingMock.mockReset()
  verifyPasqDocumentArtifactMock.mockReset()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@x.co" } })
  updateManyMock.mockResolvedValue({ count: 1 })
  clientFindUniqueMock.mockResolvedValue({ kycStatus: "VERIFIED" })
  clientDocumentFindManyMock.mockResolvedValue([])
  creditBureauCheckFindFirstMock.mockResolvedValue(passingBureauCheck)
  tenantConfigFindFirstMock.mockResolvedValue({ bureauMinScore: 450, bureauBlockAdverse: false, ndiBufferPct: 110 })
  evaluateAffordabilityGateMock.mockReturnValue({ blocked: false, ndi: 500000, requiredNdi: 1100 })
  triggerNotificationMock.mockResolvedValue(undefined)
  runBureauReviewCheckMock.mockResolvedValue("stored")
  nonOverridableBlockMock.mockReturnValue({ blocked: false })
  readCompositeKycStateMock.mockResolvedValue({
    ok: true,
    okForOrigination: true,
    state: underReviewApplication.client,
    missingCoreDocuments: [],
    biometricEvidence: null,
    latestSelfieId: "selfie-1",
  })
  txUpdateManyMock.mockResolvedValue({ count: 1 })
  txAuditLogCreateMock.mockResolvedValue({ id: "audit-1" })
  verifyLockedApprovalCandidateMock.mockResolvedValue({
    ok: true,
    application: {
      clientId: underReviewApplication.clientId,
      updatedAt: underReviewApplication.updatedAt,
      product: underReviewApplication.product,
      client: underReviewApplication.client,
    },
  })
  verifyStoredPasqBindingMock.mockReturnValue({
    ok: true,
    documentId: "pasq-doc-1",
    documentSha256: "d".repeat(64),
    evidence: {
      version: "pasq-v3",
      evidenceSha256: "e".repeat(64),
      totalCostOfCreditCents: 625_000,
      creditLife: {
        election: "DECLINED",
        monthlyPremiumCents: 2_250,
      },
      billing: {
        recurringPaymentCents: 1_000,
      },
    },
  })
  verifyPasqDocumentArtifactMock.mockResolvedValue({
    ok: true,
    document: {
      id: "pasq-doc-1",
      storagePath: "/pasq/pasq-doc-1.pdf",
      contentSha256: "d".repeat(64),
    },
    bytes: Buffer.from("%PDF-1.4 PASQ"),
  })
  txDocumentUpdateManyMock.mockResolvedValue({ count: 0 })
  txCreditLifeOfferFindFirstMock.mockResolvedValue(null)
  txExecuteRawUnsafeMock.mockResolvedValue(0)
  recomputeApplicationFlagsMock.mockResolvedValue({ recomputed: true, flags: [] })
  txCheckFlagCountMock.mockResolvedValue(0)
  txDocumentCountMock.mockResolvedValue(0)
  txAnalysisCountMock.mockResolvedValue(0)
  txPayslipFindManyMock.mockResolvedValue([])
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({
    loanApplication: { updateMany: txUpdateManyMock },
    applicationCheckFlag: { count: (a: unknown) => txCheckFlagCountMock(a) },
    clientDocument: { updateMany: (a: unknown) => txDocumentUpdateManyMock(a), count: (a: unknown) => txDocumentCountMock(a), findMany: (a: unknown) => txPayslipFindManyMock(a) },
    statementAnalysis: { count: (a: unknown) => txAnalysisCountMock(a) },
    auditLog: { create: txAuditLogCreateMock },
    $executeRawUnsafe: (sql: string) => txExecuteRawUnsafeMock(sql),
    // return_to_review re-resolves the current credit-life offer to decide
    // whether the stored election has actually gone stale.
    insuranceProduct: { findFirst: (a: unknown) => txCreditLifeOfferFindFirstMock(a) },
  }))
})

it("requires EFT or debit order before approving an application", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({
    action: "approve",
    reason: "Looks good",
    repaymentMethod: "",
  }), ctx)

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: "Select EFT or debit order as the repayment method.",
    repaymentMethod: "required",
  })
  expect(transactionMock).not.toHaveBeenCalled()
})

it("refuses to approve an OTHER-account client onto a DEBIT ORDER", async () => {
  // An OTHER account cannot carry a debit order — the Netcash AVS wire has only
  // "Current" and "Savings" — so requireDebitMandateBankDetails refuses it and
  // no mandate can ever be prepared.
  //
  // Without this bar the approval SUCCEEDS, the consumer is sent a mandate link,
  // and the flow dead-ends at "Complete on-file banking details are required",
  // for a client whose details are complete and merely OTHER. The error names
  // the wrong problem and there is no remedy on that screen. Fail at approval,
  // where the operator can still pick EFT or fix the account type.
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    client: { ...underReviewApplication.client, accountType: "OTHER" },
  })

  const res = await POST(makeReq({
    action: "approve",
    reason: "Looks good",
    repaymentMethod: "DEBIT_ORDER",
  }), ctx)

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: expect.stringContaining("cannot carry a debit order"),
    repaymentMethod: "account_type_not_debit_orderable",
  })
  expect(transactionMock).not.toHaveBeenCalled()
})

it("still approves an OTHER-account client for EFT", async () => {
  // The bar is on the debit-order COMBINATION, not on OTHER itself. OTHER is a
  // perfectly good EFT payout account — that is the whole point of the value.
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    client: { ...underReviewApplication.client, accountType: "OTHER" },
  })

  const res = await POST(makeReq({
    action: "approve",
    reason: "Looks good",
    repaymentMethod: "EFT",
  }), ctx)

  expect(res.status).not.toBe(400)
})

it("checks the deferred constraints inside the approve transaction, after its audit row", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(200)
  expect(txExecuteRawUnsafeMock).toHaveBeenCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
  // The flush must be the LAST call on tx: every approve write precedes it.
  const flushOrder = txExecuteRawUnsafeMock.mock.invocationCallOrder[0]
  const otherTxCalls = [
    ...txUpdateManyMock.mock.invocationCallOrder,
    ...txDocumentUpdateManyMock.mock.invocationCallOrder,
    ...txAuditLogCreateMock.mock.invocationCallOrder,
    ...txCreditLifeOfferFindFirstMock.mock.invocationCallOrder,
  ]
  expect(otherTxCalls.length).toBeGreaterThan(0)
  for (const order of otherTxCalls) expect(flushOrder).toBeGreaterThan(order)
  expect(txExecuteRawUnsafeMock).toHaveBeenCalledTimes(1)
})

it("409s an approval of an application that already has a loan, and does not notify", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txExecuteRawUnsafeMock.mockRejectedValueOnce(new Error(
    "Invalid `tx.$executeRawUnsafe()` invocation: Raw query failed. Code: `23514`. Message: `Loan creation and application disbursement must commit together with matching tenant and client evidence`",
  ))

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({
    error: "This application already has a loan booked against it, so it cannot be approved.",
  })
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("refuses approval while a credit check is open, naming it, before the approve transaction", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  recomputeApplicationFlagsMock.mockResolvedValue({
    recomputed: true,
    flags: [
      { id: "f1", status: "OPEN", check: "SALARY_MATCH", code: "NO_SALARY_CREDIT", summary: "No salary credit near 2026-09-25." },
      { id: "f2", status: "CLEARED", check: "RISK_BEHAVIOUR", code: "GAMBLING", summary: "Betting." },
    ],
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({
    error: "Approval blocked: 1 credit check is open. Clear it in Credit checks first.",
    openChecks: [{ id: "f1", check: "SALARY_MATCH", code: "NO_SALARY_CREDIT" }],
  })
  expect(recomputeApplicationFlagsMock).toHaveBeenCalledWith("t1", expect.any(String), expect.objectContaining({ userId: expect.any(String) }))
  expect(transactionMock).not.toHaveBeenCalled()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("re-counts open checks under the row lock and refuses before writing the approval", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txCheckFlagCountMock.mockResolvedValue(1)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect((await res.json()).error).toContain("credit check was raised while approving")
  expect(txCheckFlagCountMock).toHaveBeenCalledWith({ where: { tenantId: "t1", applicationId: expect.any(String), status: "OPEN" } })
  expect(txUpdateManyMock).not.toHaveBeenCalled()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("refuses an approval when a statement or payslip arrived after the checks ran", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txDocumentCountMock.mockResolvedValue(1)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect((await res.json()).error).toContain("changed while approving")
  expect(txDocumentCountMock).toHaveBeenCalledWith({
    where: expect.objectContaining({ tenantId: "t1", docType: { in: ["BANK_STATEMENT", "PAYSLIP"] } }),
  })
  expect(txUpdateManyMock).not.toHaveBeenCalled()
})

it("compares new evidence with the time and payslips the recompute actually read", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  const evidenceAsOf = new Date("2026-10-13T10:00:00Z")
  const evidenceSince = new Date("2026-07-15T00:00:00Z")
  recomputeApplicationFlagsMock.mockResolvedValue({ recomputed: true, flags: [], evidenceAsOf, evidenceSince, payslipSnapshot: ["slip-1:done:gen-1"] })
  txPayslipFindManyMock.mockResolvedValue([{ id: "slip-1", extractionStatus: "done", extractionGeneration: "gen-1" }])

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(200)
  expect(txDocumentCountMock).toHaveBeenCalledWith({ where: {
    tenantId: "t1", clientId: expect.any(String), docType: { in: ["BANK_STATEMENT", "PAYSLIP"] },
    OR: [{ createdAt: { gt: evidenceAsOf } }, { deletedAt: { gt: evidenceAsOf } }],
  } })
  expect(txAnalysisCountMock).toHaveBeenCalledWith({ where: { tenantId: "t1", createdAt: { gt: evidenceAsOf }, clientDocument: { clientId: expect.any(String) } } })
  expect(txPayslipFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
    where: { tenantId: "t1", clientId: expect.any(String), docType: "PAYSLIP", deletedAt: null, createdAt: { gte: evidenceSince } },
  }))
})

it("refuses an approval when a payslip's extraction changed after the checks read it", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  recomputeApplicationFlagsMock.mockResolvedValue({ recomputed: true, flags: [], evidenceAsOf: new Date(), evidenceSince: new Date(0), payslipSnapshot: ["slip-1:done:gen-1"] })
  for (const now of [
    [{ id: "slip-1", extractionStatus: "processing", extractionGeneration: "gen-2" }],
    [{ id: "slip-1", extractionStatus: "done", extractionGeneration: "gen-2" }],
    [{ id: "slip-1", extractionStatus: "done", extractionGeneration: "gen-1" }, { id: "slip-2", extractionStatus: "processing", extractionGeneration: "g" }],
  ]) {
    txPayslipFindManyMock.mockResolvedValueOnce(now)
    const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
    expect(res.status).toBe(409)
  }
  expect(txUpdateManyMock).not.toHaveBeenCalled()
})

it("refuses an approval when a statement was read after the checks ran", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txAnalysisCountMock.mockResolvedValue(1)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect(txUpdateManyMock).not.toHaveBeenCalled()
})

it("409s when the open-check-flags trigger refuses the approval write", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txUpdateManyMock.mockRejectedValueOnce(new Error(
    "Raw query failed. Code: `23514`. Message: `Application app_1 has open credit-check flags; clear them before approval`",
  ))

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect((await res.json()).error).toContain("credit check was raised while approving")
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("still 500s an approval whose constraint check fails for any other reason", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txExecuteRawUnsafeMock.mockRejectedValueOnce(new Error("connection reset"))

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(500)
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("approves an UNDER_REVIEW application (happy path)", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const json = await res.json() as { ok: boolean }

  expect(res.status).toBe(200)
  expect(json.ok).toBe(true)
  expect(creditBureauCheckFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      applicationId: "app-1",
      reviewGeneration: "review-generation-1",
      clientId: "client-1",
    }),
  }))
  expect(txUpdateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "UNDER_REVIEW",
      updatedAt: underReviewApplication.updatedAt,
    },
    data: expect.objectContaining({
      status: "APPROVED",
      repaymentMethod: "EFT",
      approvedById: "u1",
      approvedAmount: 500000,
      approvedTermDays: 30,
      approvedRate: 0.05,
      agreementGeneratedAt: null,
      agreementSignedAt: null,
      agreementSignedMethod: null,
      agreementSignedByIp: null,
      agreementSignedByUserId: null,
      agreementSignatureData: null,
      agreementCountersignedAt: null,
      agreementCountersignedById: null,
      agreementCountersignedByName: null,
      agreementCountersignedByEmail: null,
      agreementCountersignatureData: null,
      agreementCountersignatureSha256: null,
      agreementCountersignedDocumentSha256: null,
      // The EXECUTED artifact belongs to the agreement lifecycle being torn
      // down. Leaving either column set makes the application permanently
      // un-countersignable — the preflight refuses on it and the countersign
      // updateMany predicate requires it to be null — which blocks
      // disbursement with no in-app remedy.
      agreementExecutedDocumentId: null,
      agreementExecutedDocumentSha256: null,
      // NCA s.92(1) attaches the quotation to entering into the agreement, not
      // to the credit decision. Approval therefore records no quotation, and
      // actively clears any it inherited so the document the consumer
      // acknowledges is always minted after the decision it prices.
      approvedPasqDocumentSha256: null,
      pasqVersion: null,
      pasqGeneratedAt: null,
      pasqDocumentId: null,
      pasqDocumentSha256: null,
      pasqEvidenceSha256: null,
      pasqAcknowledgedAt: null,
      pasqAcknowledgedBy: null,
      pasqAcknowledgedSha256: null,
      netDisposableIncome: 500000,
      affordabilityNDI: 499000,
      affordabilityResult: expect.objectContaining({
        schemaVersion: 3,
        submission: underReviewApplication.affordabilityResult.submission,
        approval: expect.objectContaining({
          stage: "APPROVAL",
          capturedById: "u1",
          inputs: expect.objectContaining({
            monthlyIncomeCents: 1000000,
            monthlyExpensesCents: 500000,
            applicationDebtCents: 25000,
            clientDebtCents: 25000,
            declaredDebtCents: 25000,
            bureauObligationsCents: 10000,
            principalCents: 500000,
            productId: "product-1",
          }),
          debts: expect.objectContaining({
            application: [expect.objectContaining({ sourceId: "app-debt-1", provider: "Bank A" })],
            client: [expect.objectContaining({ sourceId: "client-debt-1", provider: "Bank A" })],
          }),
          expenses: expect.objectContaining({
            source: "CLIENT_BREAKDOWN",
            sourceId: "expense-1",
            grossMonthlyIncomeCents: 1_100_000,
            breakdownTotalCents: 500000,
          }),
          bureauEvidence: expect.objectContaining({
            mode: "CHECK",
            check: expect.objectContaining({
              id: "bureau-1",
              clientId: "client-1",
              subjectFingerprint: "a".repeat(64),
              obligationsCents: 10000,
            }),
            policy: { minimumScore: 450, blockAdverse: false },
          }),
          inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          decisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    }),
  })
  expect(txAuditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "LOAN_APPROVED",
      entityId: "app-1",
      newValue: expect.objectContaining({
        repaymentMethod: "EFT",
        approvedAmount: 500000,
        approvedTermDays: 30,
        approvedRate: 0.05,
        // The quotation is issued after this decision, so the approval records
        // the instalment it actually gated on rather than a quotation digest.
        // PASQ_GENERATED / PASQ_ACKNOWLEDGED carry the document evidence.
        approvedInstalmentCents: 1_000,
        creditLifePremiumCents: 0,
      }),
    }),
  })
})

it("approves without any biometric evidence — origination does not require a selfie", async () => {
  // The one behaviour the policy change alters, and the case where the two
  // flags MUST diverge: strict composite fails (no selfie), origination passes.
  // Both approval gates have to honour the origination grade or this 409s with
  // "KYC evidence changed", which would be false — nothing changed.
  findUniqueMock.mockResolvedValue(underReviewApplication)
  readCompositeKycStateMock.mockResolvedValue({
    ok: false,
    okForOrigination: true,
    state: underReviewApplication.client,
    missingCoreDocuments: [],
    biometricEvidence: "biometric_evidence_missing",
    latestSelfieId: null,
  })

  const response = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(response.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: "APPROVED" }),
  }))
})

it("rejects cached VERIFIED KYC when the composite evidence is incomplete", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  readCompositeKycStateMock.mockResolvedValueOnce({
    ok: false,
    okForOrigination: false,
    state: {
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP"],
    biometricEvidence: null,
    latestSelfieId: "selfie-1",
  })

  const response = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "KYC not complete.",
    kycStatus: "PENDING",
    missingDocs: ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP"],
    biometricEvidence: null,
  })
  expect(transactionMock).not.toHaveBeenCalled()
  expect(txUpdateManyMock).not.toHaveBeenCalled()
})

it("names the ID copy as the approval blocker while the selfie awaits its verification", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  readCompositeKycStateMock.mockResolvedValueOnce({
    ok: false,
    okForOrigination: false,
    biometricAwaitingIdVerification: true,
    state: {
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    },
    missingCoreDocuments: ["ID_COPY"],
    biometricEvidence: "subject_identity_changed",
    latestSelfieId: "selfie-1",
    awaitingIdDocumentId: "id-doc-1",
  })

  const response = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: "The client's ID copy must be verified before approval; the selfie already matched it.",
    kycStatus: "PENDING",
    missingDocs: ["ID_COPY"],
    biometricEvidence: "subject_identity_changed",
    idCopyAwaitingVerification: true,
    documentId: "selfie-1",
    idDocumentId: "id-doc-1",
  })
  expect(transactionMock).not.toHaveBeenCalled()
})

it("rechecks composite KYC inside the approval transaction and blocks a mid-flight change", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  readCompositeKycStateMock
    .mockResolvedValueOnce({
      ok: true,
      okForOrigination: true,
      state: underReviewApplication.client,
      missingCoreDocuments: [],
      biometricEvidence: null,
      latestSelfieId: "selfie-1",
    })
    .mockResolvedValueOnce({
      ok: false,
      okForOrigination: false,
      state: {
        kycStatus: "PENDING",
        kycVerifiedAt: null,
        kycVerifiedById: null,
        kycVerificationMethod: null,
      },
      missingCoreDocuments: ["PAYSLIP"],
      biometricEvidence: null,
      latestSelfieId: "selfie-1",
    })

  const response = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({
    error: "KYC evidence changed before the application could be approved; refresh and complete KYC again.",
    kycEvidence: "changed",
  })
  expect(readCompositeKycStateMock).toHaveBeenCalledTimes(2)
  expect(txUpdateManyMock).not.toHaveBeenCalled()
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
})

it("rejects an unreasoned bureau override before changing the application", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({
    action: "approve",
    reason: "Looks good",
    bureauOverrideReason: "short",
  }), ctx)

  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({
    error: "Bureau override reason must be at least 10 characters.",
    bureauOverrideValidation: "reason_too_short",
  })
  expect(updateManyMock).not.toHaveBeenCalled()
})

it.each([
  ["missing", null, "submission_missing"],
  ["legacy", { schemaVersion: 1 }, "submission_missing"],
  ["malformed", { schemaVersion: 3, submission: { stage: "SUBMISSION" } }, "submission_changed"],
  ["tampered", tamperedSubmissionAffordabilityResult, "submission_changed"],
])("rejects approval when submission evidence is %s", async (_label, affordabilityResult, expectedReason) => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    affordabilityResult,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { affordabilitySnapshot: string }

  expect(res.status).toBe(422)
  expect(body.affordabilitySnapshot).toBe(expectedReason)
  expect(clientFindUniqueMock).not.toHaveBeenCalled()
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rejects approval when the submission snapshot is not bound to submittedAt", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    submittedAt: new Date("2026-07-18T11:48:00Z"),
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { affordabilitySnapshot: string }

  expect(res.status).toBe(422)
  expect(body.affordabilitySnapshot).toBe("submission_changed")
  expect(clientFindUniqueMock).not.toHaveBeenCalled()
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("does not let a reasoned bureau override bypass failed affordability", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  evaluateAffordabilityGateMock.mockReturnValue({
    blocked: true,
    ndi: 100_000,
    requiredNdi: 250_000,
    reason: "Insufficient net disposable income",
  })

  const res = await POST(makeReq({
    action: "approve",
    reason: "Reviewed",
    bureauOverrideReason: "Verified bureau exception with supporting evidence",
  }), ctx)
  const body = await res.json() as { requiresOverride: boolean }

  expect(res.status).toBe(422)
  expect(body.requiresOverride).toBe(false)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("marks a deceased bureau result as explicitly non-overridable", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  nonOverridableBlockMock.mockReturnValue({
    blocked: true,
    reason: "The bureau reports the consumer as deceased.",
  })

  const res = await POST(makeReq({
    action: "approve",
    reason: "Reviewed",
    bureauOverrideReason: "Verified bureau exception with supporting evidence",
  }), ctx)

  expect(res.status).toBe(422)
  expect(await res.json()).toEqual({
    error: "Approval blocked: The bureau reports the consumer as deceased. This cannot be overridden.",
    deceasedBlock: true,
    requiresOverride: false,
  })
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rejects approval when fresh client and staff compliance evidence is missing", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    clientAffordabilityDeclaredAt: null,
    recklessLendingAssessed: false,
    recklessLendingAssessedAt: null,
    recklessLendingAssessedById: null,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { missingComplianceEvidence: string[] }

  expect(res.status).toBe(422)
  expect(body.missingComplianceEvidence).toEqual([
    "client affordability declaration",
    "reckless-lending assessment",
  ])
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("approves an application that has no quotation at all", async () => {
  // The re-sequencing in one assertion: on the previous gate this exact
  // application was refused with pasqEvidence "missing".
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    pasqGeneratedAt: null,
    pasqDocumentId: null,
    pasqDocumentSha256: null,
    pasqEvidence: null,
    pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(200)
  // Approval must not consult a quotation it no longer requires — reading one
  // here is how the old ordering would creep back in.
  expect(verifyStoredPasqBindingMock).not.toHaveBeenCalled()
  expect(verifyPasqDocumentArtifactMock).not.toHaveBeenCalled()
})

it("clears an inherited quotation when approving", async () => {
  // An application that carried a quotation from the previous sequencing must
  // not drag it into its ceremony: the consumer would then acknowledge a
  // document priced before the decision that approved it.
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock.mock.calls[0][0].data).toMatchObject({
    pasqVersion: null,
    pasqGeneratedAt: null,
    pasqDocumentId: null,
    pasqDocumentSha256: null,
    pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
    approvedPasqDocumentSha256: null,
  })
})

it("approves a NO-OFFER application (DECLINED, premium 0) without a billing error", async () => {
  // Regression for a no-offer application failing billing validation, this time
  // at approval-time billing: the helper rejects premium 0 when `offered`
  // defaults to true, so an approval path that omits the flag turns every
  // no-offer application into a 422 "billing schedule outside range".
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: "credit-life-no-offer-v1",
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: "credit-life-no-offer-v1",
      election: "DECLINED",
      principalCents: underReviewApplication.appliedAmount,
      termDays: underReviewApplication.appliedTermDays,
    }),
    pasqGeneratedAt: null,
    pasqDocumentId: null,
    pasqDocumentSha256: null,
    pasqEvidence: null,
    pasqEvidenceSha256: null,
    pasqAcknowledgedAt: null,
    pasqAcknowledgedBy: null,
    pasqAcknowledgedSha256: null,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(200)
})

it("rejects approval without acknowledged credit-life evidence", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    creditLifeDisclosureAcknowledgedAt: null,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { creditLifeEvidence: string }

  expect(res.status).toBe(422)
  expect(body.creditLifeEvidence).toBe("missing")
  expect(transactionMock).not.toHaveBeenCalled()
})

it("rejects approval when the exact credit-life premium was changed after acknowledgement", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    creditLifeMonthlyPremiumCents:
      underReviewApplication.creditLifeMonthlyPremiumCents - 1,
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { creditLifeEvidence: string }

  expect(res.status).toBe(422)
  expect(body.creditLifeEvidence).toBe("premium_mismatch")
  expect(transactionMock).not.toHaveBeenCalled()
})

it("rejects approval when Regulation 23A living expenses are below the minimum without justification", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    client: {
      ...underReviewApplication.client,
      monthlyExpenses: 0,
      expenseBreakdown: {
        ...underReviewApplication.client.expenseBreakdown,
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
    },
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { mleJustificationMissing: boolean }

  expect(res.status).toBe(422)
  expect(body.mleJustificationMissing).toBe(true)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rejects approval when itemised expenses contradict the client expense total", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    client: {
      ...underReviewApplication.client,
      expenseBreakdown: {
        ...underReviewApplication.client.expenseBreakdown,
        housing: underReviewApplication.client.expenseBreakdown.housing + 1,
      },
    },
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { expenseEvidenceInvalid: boolean }

  expect(res.status).toBe(422)
  expect(body.expenseEvidenceInvalid).toBe(true)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("rejects malformed persisted debt evidence instead of returning a server error", async () => {
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    existingDebtObligations: [{
      ...underReviewApplication.existingDebtObligations[0],
      monthlyInstalment: "not-cents",
    }],
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)
  const body = await res.json() as { debtEvidenceInvalid?: boolean }

  expect(res.status).toBe(422)
  expect(body.debtEvidenceInvalid).toBe(true)
  expect(transactionMock).not.toHaveBeenCalled()
})

it("409s on approve when a concurrent decision already moved the application off UNDER_REVIEW, skips audit", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  verifyLockedApprovalCandidateMock.mockResolvedValue({
    ok: false,
    reason: "application_changed",
  })

  const res = await POST(makeReq({ action: "approve", reason: "Looks good" }), ctx)

  expect(res.status).toBe(409)
  expect(txUpdateManyMock).not.toHaveBeenCalled()
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("declines an UNDER_REVIEW application (happy path)", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)
  const json = await res.json() as { ok: boolean }

  expect(res.status).toBe(200)
  expect(json.ok).toBe(true)
  expect(txUpdateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "UNDER_REVIEW",
      updatedAt: underReviewApplication.updatedAt,
    },
    data: expect.objectContaining({ status: "DECLINED", declineCategory: "AFFORDABILITY" }),
  })
  expect(txAuditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "LOAN_DECLINED",
      entityId: "app-1",
      newValue: expect.objectContaining({ declineCategory: "AFFORDABILITY" }),
    }),
  })
})

it.each([
  ["missing", {}],
  ["blank", { declineCategory: "" }],
  ["unknown", { declineCategory: "FRAUD" }],
])("400s a decline with a %s category and writes nothing", async (_label, extra) => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", ...extra }), ctx)

  expect(res.status).toBe(400)
  expect(txUpdateManyMock).not.toHaveBeenCalled()
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("409s on decline when a concurrent decision already moved the application off UNDER_REVIEW, skips audit", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txUpdateManyMock.mockResolvedValue({ count: 0 })

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)

  expect(res.status).toBe(409)
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("checks the deferred constraints inside the decline transaction, after its audit row", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)

  expect(res.status).toBe(200)
  expect(txExecuteRawUnsafeMock).toHaveBeenCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
  expect(txExecuteRawUnsafeMock.mock.invocationCallOrder[0])
    .toBeGreaterThan(txAuditLogCreateMock.mock.invocationCallOrder[0])
})

it("409s a decline of an application that already has a loan, and does not notify", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txExecuteRawUnsafeMock.mockRejectedValueOnce(new Error(
    "Invalid `tx.$executeRawUnsafe()` invocation: Raw query failed. Code: `23514`. Message: `Loan creation and application disbursement must commit together with matching tenant and client evidence`",
  ))

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)

  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({
    error: "This application already has a loan booked against it, so it cannot be declined.",
  })
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("still 500s a decline whose constraint check fails for any other reason", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txExecuteRawUnsafeMock.mockRejectedValueOnce(new Error("connection reset"))

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)

  expect(res.status).toBe(500)
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("500s and does not notify when the mandatory decline audit insert fails", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txAuditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

  const res = await POST(makeReq({ action: "decline", reason: "Failed affordability", declineCategory: "AFFORDABILITY" }), ctx)

  expect(res.status).toBe(500)
  expect(txUpdateManyMock).toHaveBeenCalledOnce()
  expect(txAuditLogCreateMock).toHaveBeenCalledOnce()
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("clears AND retires the executed agreement when returning to draft", async () => {
  // Without the column clears the application can never be countersigned
  // again — the preflight refuses on them and the countersign updateMany
  // predicate requires them null — so disbursement is blocked with no in-app
  // remedy. And the retirement must happen HERE: afterwards the
  // locked-statutory guard makes the document undeletable.
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    agreementExecutedDocumentId: "executed-doc-1",
    agreementExecutedDocumentSha256: "a".repeat(64),
  })

  const res = await POST(makeReq({
    action: "return_to_draft",
    reason: "Submission affordability evidence must be recaptured",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      agreementExecutedDocumentId: null,
      agreementExecutedDocumentSha256: null,
    }),
  }))
  expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      id: "executed-doc-1",
      docType: "EXECUTED_CREDIT_AGREEMENT",
      deletedAt: null,
    }),
    data: expect.objectContaining({ deletedByType: "staff" }),
  }))
})

it("names the retired executed agreement in the audit trail", async () => {
  // The audit log is the register auditors query; a return that silently drops
  // the document carrying BOTH signatures is not an answerable record.
  findUniqueMock.mockResolvedValue({
    ...underReviewApplication,
    agreementExecutedDocumentId: "executed-doc-1",
    agreementExecutedDocumentSha256: "a".repeat(64),
  })

  await POST(makeReq({
    action: "return_to_draft",
    reason: "Submission affordability evidence must be recaptured",
  }), ctx)

  expect(txAuditLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      newValue: expect.objectContaining({
        executedAgreementRetired: true,
        executedAgreementDocumentId: "executed-doc-1",
      }),
    }),
  }))
})

it("returns an under-review application to draft so submission evidence can be recaptured", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({
    action: "return_to_draft",
    reason: "Submission affordability evidence must be recaptured",
  }), ctx)

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true, status: "DRAFT" })
  expect(txUpdateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "UNDER_REVIEW",
      updatedAt: underReviewApplication.updatedAt,
    },
    data: expect.objectContaining({
      status: "DRAFT",
      submittedAt: null,
      assignedToId: null,
      netDisposableIncome: null,
      affordabilityNDI: null,
      affordabilityResult: expect.objectContaining({
        schemaVersion: 3,
        submissionHistory: [underReviewApplication.affordabilityResult.submission],
      }),
      pasqAcknowledgedAt: null,
      pasqAcknowledgedBy: null,
      pasqAcknowledgedSha256: null,
      pasqVersion: null,
      pasqGeneratedAt: null,
      pasqDocumentId: null,
      pasqDocumentSha256: null,
      pasqEvidence: expect.anything(),
      pasqEvidenceSha256: null,
      approvedPasqDocumentSha256: null,
      clientAffordabilityDeclaredAt: null,
      creditLifeElection: null,
      creditLifeProductId: null,
      creditLifeProductName: null,
      creditLifeInsurerId: null,
      creditLifeInsurerName: null,
      creditLifeMonthlyPremiumCents: null,
      creditLifeDisclosureVersion: null,
      creditLifeDisclosureSha256: null,
      creditLifeDisclosureAcknowledgedAt: null,
      creditLifeDisclosureAcknowledgedBy: null,
      recklessLendingAssessed: false,
    }),
  })
  expect(txAuditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "APPLICATION_RETURNED_TO_DRAFT",
      entityId: "app-1",
      oldValue: expect.objectContaining({
        status: "UNDER_REVIEW",
        submissionEvidencePresent: true,
        submissionDecisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      newValue: expect.objectContaining({
        status: "DRAFT",
        complianceEvidenceReset: true,
        priorEvidencePreserved: true,
      }),
    }),
  })
  const returnedData = txUpdateManyMock.mock.calls[0][0].data
  expect(returnedData.affordabilityResult).not.toHaveProperty("submission")
})

it("rejects return-to-draft without a meaningful reason", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)

  const res = await POST(makeReq({
    action: "return_to_draft",
    reason: "short",
  }), ctx)

  expect(res.status).toBe(400)
  expect(transactionMock).not.toHaveBeenCalled()
})

it("409s without an audit when return-to-draft loses a concurrent update race", async () => {
  findUniqueMock.mockResolvedValue(underReviewApplication)
  txUpdateManyMock.mockResolvedValue({ count: 0 })

  const res = await POST(makeReq({
    action: "return_to_draft",
    reason: "Submission affordability evidence must be recaptured",
  }), ctx)

  expect(res.status).toBe(409)
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
})

it("returns an approved undisbursed application to review and archives its approval evidence", async () => {
  findUniqueMock.mockResolvedValue(approvedApplication)

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Customer expenses changed after approval",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledWith({
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "APPROVED",
      updatedAt: approvedApplication.updatedAt,
    },
    data: expect.objectContaining({
      status: "UNDER_REVIEW",
      repaymentMethod: null,
      approvedById: null,
      approvedAt: null,
      approvedAmount: null,
      approvedTermDays: null,
      affordabilityResult: expect.objectContaining({
        schemaVersion: 3,
        approvalHistory: [approvedApplication.affordabilityResult.approval],
      }),
      bureauOverrideReason: null,
      bureauReviewGeneration: expect.any(String),
      agreementGeneratedAt: null,
      agreementSignedAt: null,
      agreementSignatureData: null,
      agreementCountersignedAt: null,
      agreementCountersignatureData: null,
      agreementCountersignatureSha256: null,
      agreementCountersignatureEnvelopeSha256: null,
      agreementCountersignedDocumentSha256: null,
      pasqAcknowledgedAt: null,
      pasqAcknowledgedSha256: null,
      pasqDocumentId: null,
      pasqDocumentSha256: null,
      pasqEvidenceSha256: null,
      approvedPasqDocumentSha256: null,
      clientAffordabilityDeclaredAt: null,
    }),
  })
  const guardedTransition = txUpdateManyMock.mock.calls[0][0].data
  expect(guardedTransition).not.toHaveProperty("creditLifeElection")
  expect(guardedTransition).not.toHaveProperty("creditLifeDisclosureAcknowledgedAt")
  expect(txUpdateManyMock).toHaveBeenNthCalledWith(2, {
    where: {
      id: "app-1",
      tenantId: "t1",
      status: "UNDER_REVIEW",
    },
    data: expect.objectContaining({
      creditLifeElection: null,
      creditLifeProductId: null,
      creditLifeProductName: null,
      creditLifeInsurerId: null,
      creditLifeInsurerName: null,
      creditLifeMonthlyPremiumCents: null,
      creditLifeDisclosureVersion: null,
      creditLifeDisclosureSha256: null,
      creditLifeDisclosureAcknowledgedAt: null,
      creditLifeDisclosureAcknowledgedBy: null,
    }),
  })
  expect(txAuditLogCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "APPLICATION_RETURNED_TO_REVIEW",
      oldValue: expect.objectContaining({
        repaymentMethod: "EFT",
        agreementSignaturePresent: true,
        agreementSignatureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      newValue: expect.objectContaining({
        status: "UNDER_REVIEW",
        reason: "Customer expenses changed after approval",
        priorApprovalArchived: true,
        agreementInvalidated: true,
        agreementDocumentRetained: true,
      }),
    }),
  })
  const reviewGeneration = txUpdateManyMock.mock.calls[0][0].data.bureauReviewGeneration
  expect(runBureauReviewCheckMock).toHaveBeenCalledWith({
    tenantId: "t1",
    applicationId: "app-1",
    clientId: "client-1",
    reviewGeneration,
  })
})

it("409s without an audit when return-to-review loses a concurrent update race", async () => {
  findUniqueMock.mockResolvedValue(approvedApplication)
  txUpdateManyMock.mockResolvedValue({ count: 0 })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Customer expenses changed after approval",
  }), ctx)

  expect(res.status).toBe(409)
  expect(txAuditLogCreateMock).not.toHaveBeenCalled()
  expect(runBureauReviewCheckMock).not.toHaveBeenCalled()
})

it("refuses to return an application to review when a loan already exists", async () => {
  findUniqueMock.mockResolvedValue({ ...approvedApplication, loan: { id: "loan-1" } })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Customer expenses changed after approval",
  }), ctx)

  expect(res.status).toBe(400)
  expect(transactionMock).not.toHaveBeenCalled()
})

it("400s when the application is not UNDER_REVIEW, without touching updateMany", async () => {
  findUniqueMock.mockResolvedValue({ ...underReviewApplication, status: "SUBMITTED" })

  const res = await POST(makeReq({ action: "approve", reason: "x" }), ctx)

  expect(res.status).toBe(400)
  expect(updateManyMock).not.toHaveBeenCalled()
})

it("404s when the application does not exist in the tenant", async () => {
  findUniqueMock.mockResolvedValue(null)
  const res = await POST(makeReq({ action: "approve", reason: "x" }), ctx)
  expect(res.status).toBe(404)
})

// Un-approving to correct one credit obligation
// must not clear a still-valid credit-life election: the only surface that can
// recapture one is the draft wizard — which also discards the bureau enquiry.
// The consumer would pay for a second bureau footprint to re-record identical
// evidence. Nothing this transition touches is bound by the disclosure hash.
it("retains a no-offer credit-life election when there is still no offer", async () => {
  findUniqueMock.mockResolvedValue({
    ...approvedApplication,
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: "credit-life-no-offer-v1",
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: "credit-life-no-offer-v1",
      election: "DECLINED",
      principalCents: approvedApplication.appliedAmount,
      termDays: approvedApplication.appliedTermDays,
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T12:00:00Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  })
  txCreditLifeOfferFindFirstMock.mockResolvedValue(null)

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Correcting a mis-captured credit obligation",
  }), ctx)

  expect(res.status).toBe(200)
  // The status transition still runs; only the second, clearing update must not.
  expect(txUpdateManyMock).toHaveBeenCalledOnce()
  expect(txUpdateManyMock.mock.calls[0][0].data).toMatchObject({ status: "UNDER_REVIEW" })
  const retainedAudit = txAuditLogCreateMock.mock.calls[0][0].data.newValue
  expect(retainedAudit).toMatchObject({ creditLifeEvidence: "retained" })
  // "retained" alone cannot tell an auditor WHICH election crossed a boundary
  // that nulls every other consumer acknowledgement on the row.
  expect(retainedAudit).toMatchObject({
    retainedCreditLifeElection: "DECLINED",
    retainedCreditLifeDisclosureVersion: "credit-life-no-offer-v1",
    retainedCreditLifeAcknowledgedBy: "client-1",
  })
  expect(retainedAudit.retainedCreditLifeDisclosureSha256).toMatch(/^[0-9a-f]{64}$/)
})

it("clears a no-offer credit-life election once an insurer has been onboarded", async () => {
  findUniqueMock.mockResolvedValue({
    ...approvedApplication,
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: "credit-life-no-offer-v1",
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: "credit-life-no-offer-v1",
      election: "DECLINED",
      principalCents: approvedApplication.appliedAmount,
      termDays: approvedApplication.appliedTermDays,
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T12:00:00Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  })
  txCreditLifeOfferFindFirstMock.mockResolvedValue({
    id: "prod-1",
    name: "Credit Life Cover",
    insurerId: "ins-1",
    insurer: { name: "Example Insurer" },
  })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Correcting a mis-captured credit obligation",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledTimes(2)
  expect(txUpdateManyMock.mock.calls[1][0].data).toMatchObject({
    creditLifeElection: null,
    creditLifeDisclosureSha256: null,
  })
  expect(txAuditLogCreateMock.mock.calls[0][0].data.newValue).toMatchObject({
    creditLifeEvidence: "cleared:offer_now_available",
  })
})

// The route maps a Prisma product row onto the offer shape field by field. The
// pure retention helper never sees that mapping, so a swapped productName /
// insurerName passed every test while silently discarding valid elections.
// These fixtures give the product and the insurer DIFFERENT names on purpose —
// swap the two lines in the route and this test fails.
function offeredElectionApplication() {
  const monthlyPremiumCents = 2250
  return {
    ...approvedApplication,
    creditLifeElection: "ACCEPTED",
    creditLifeProductId: "credit-life-1",
    creditLifeProductName: "Acme Credit Life",
    creditLifeInsurerId: "insurer-1",
    creditLifeInsurerName: "Test Life",
    creditLifeMonthlyPremiumCents: monthlyPremiumCents,
    creditLifeDisclosureVersion: "credit-life-election-v1",
    creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
      version: "credit-life-election-v1",
      election: "ACCEPTED",
      principalCents: approvedApplication.appliedAmount,
      termDays: approvedApplication.appliedTermDays,
      monthlyPremiumCents,
      productId: "credit-life-1",
      productName: "Acme Credit Life",
      insurerId: "insurer-1",
      insurerName: "Test Life",
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T12:00:00Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  }
}

it("retains an offer-backed election when the same offer still resolves", async () => {
  findUniqueMock.mockResolvedValue(offeredElectionApplication())
  txCreditLifeOfferFindFirstMock.mockResolvedValue({
    id: "credit-life-1",
    name: "Acme Credit Life",
    insurerId: "insurer-1",
    insurer: { name: "Test Life" },
  })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Correcting a mis-captured credit obligation",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledOnce()
  expect(txAuditLogCreateMock.mock.calls[0][0].data.newValue).toMatchObject({
    creditLifeEvidence: "retained",
  })
})

it("clears an offer-backed election when the insurer has changed", async () => {
  findUniqueMock.mockResolvedValue(offeredElectionApplication())
  txCreditLifeOfferFindFirstMock.mockResolvedValue({
    id: "credit-life-1",
    name: "Acme Credit Life",
    insurerId: "insurer-2",
    insurer: { name: "Different Insurer" },
  })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Correcting a mis-captured credit obligation",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledTimes(2)
  expect(txUpdateManyMock.mock.calls[1][0].data).toMatchObject({
    creditLifeElection: null,
  })
  expect(txAuditLogCreateMock.mock.calls[0][0].data.newValue).toMatchObject({
    creditLifeEvidence: "cleared:offer_changed",
  })
})

// This ordered lookup takes the first active product; the DB approval guard
// re-checks with an unordered EXISTS that ignores blank-named rows. A blank
// first row must therefore NOT read as "no offer" — the guard could still find
// a usable one and reject at approval, where staff cannot act on it.
it("clears rather than retains when the resolved product is unpresentable", async () => {
  findUniqueMock.mockResolvedValue({
    ...approvedApplication,
    creditLifeElection: "DECLINED",
    creditLifeProductId: null,
    creditLifeProductName: null,
    creditLifeInsurerId: null,
    creditLifeInsurerName: null,
    creditLifeMonthlyPremiumCents: 0,
    creditLifeDisclosureVersion: "credit-life-no-offer-v1",
    creditLifeDisclosureSha256: createCreditLifeNoOfferDisclosureSha256({
      version: "credit-life-no-offer-v1",
      election: "DECLINED",
      principalCents: approvedApplication.appliedAmount,
      termDays: approvedApplication.appliedTermDays,
    }),
    creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T12:00:00Z"),
    creditLifeDisclosureAcknowledgedBy: "client-1",
  })
  txCreditLifeOfferFindFirstMock.mockResolvedValue({
    id: "credit-life-blank",
    name: "   ",
    insurerId: "insurer-1",
    insurer: { name: "Test Life" },
  })

  const res = await POST(makeReq({
    action: "return_to_review",
    reason: "Correcting a mis-captured credit obligation",
  }), ctx)

  expect(res.status).toBe(200)
  expect(txUpdateManyMock).toHaveBeenCalledTimes(2)
  expect(txAuditLogCreateMock.mock.calls[0][0].data.newValue).toMatchObject({
    creditLifeEvidence: "cleared:offer_changed",
  })
})
