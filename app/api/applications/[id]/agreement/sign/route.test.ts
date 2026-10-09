import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { calculateLoan } from "@/lib/loan-calculator"
import {
  APPROVAL_AFFORDABILITY_POLICY_VERSION,
  createAffordabilityContractEvidence,
  createAffordabilityExpenseEvidence,
  createAffordabilitySnapshot,
  withAffordabilityContract,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { southAfricanCalendarDate } from "@/lib/compliance/sa-business-days"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const {
  authMock,
  applicationFindUniqueMock,
  agreementDocumentFindFirstMock,
  txAgreementDocumentFindFirstMock,
  transactionMock,
  txApplicationUpdateManyMock,
  txApplicationFindUniqueMock,
  txDocumentUpdateManyMock,
  txAuditCreateMock,
  txQueryRawMock,
  bureauCheckFindFirstMock,
  tenantConfigFindUniqueMock,
  verifyCurrentAffordabilityApprovalMock,
  verifyLockedCurrentAffordabilityApprovalMock,
  verifyStoredPasqBindingMock,
  verifyPasqDocumentArtifactMock,
  readFileMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  agreementDocumentFindFirstMock: vi.fn(),
  txAgreementDocumentFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  txApplicationUpdateManyMock: vi.fn(),
  txApplicationFindUniqueMock: vi.fn(),
  txDocumentUpdateManyMock: vi.fn(),
  txAuditCreateMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  bureauCheckFindFirstMock: vi.fn(),
  tenantConfigFindUniqueMock: vi.fn(),
  verifyCurrentAffordabilityApprovalMock: vi.fn(),
  verifyLockedCurrentAffordabilityApprovalMock: vi.fn(),
  verifyStoredPasqBindingMock: vi.fn(),
  verifyPasqDocumentArtifactMock: vi.fn(),
  readFileMock: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: (...args: unknown[]) => applicationFindUniqueMock(...args),
    },
    clientDocument: {
      findFirst: (...args: unknown[]) => agreementDocumentFindFirstMock(...args),
    },
    creditBureauCheck: { findFirst: (...args: unknown[]) => bureauCheckFindFirstMock(...args) },
    tenantConfig: { findUnique: (...args: unknown[]) => tenantConfigFindUniqueMock(...args) },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_target, key) => String(key) }),
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyCurrentAffordabilityApprovalMock(...args),
  verifyLockedCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyLockedCurrentAffordabilityApprovalMock(...args),
}))
vi.mock("@/lib/compliance/pasq", () => ({
  verifyStoredPasqBinding: (...args: unknown[]) => verifyStoredPasqBindingMock(...args),
}))
vi.mock("@/lib/compliance/pasq-document.server", () => ({
  verifyPasqDocumentArtifact: (...args: unknown[]) => verifyPasqDocumentArtifactMock(...args),
}))
vi.mock("@/lib/storage", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const approvalAt = new Date("2026-07-20T08:30:00.000Z")
const contractAt = new Date("2026-07-20T09:00:00.000Z")
const agreementPdf = Buffer.from("%PDF-1.4 signed agreement")
const agreementPdfSha256 = sha256DocumentBytes(agreementPdf)
const returnedPacketPdf = Buffer.from("%PDF-1.4 returned signed packet")
const returnedPacketSha256 = sha256DocumentBytes(returnedPacketPdf)
const drawnSignature = `data:image/png;base64,${Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(96),
]).toString("base64")}`
const calculationInputs = {
  principal: 500_000,
  termDays: 30,
  interestRatePm: 0.03,
  interestModel: "DAILY_ACCRUAL" as const,
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.15,
  initiationFeeMax: 105_000,
  monthlyServiceFee: 6_900,
  productType: "MICRO",
  initiationFeePayment: "DEFERRED" as const,
}
const approvalCalculation = calculateLoan(calculationInputs, approvalAt)
const approval = createAffordabilitySnapshot({
  stage: "APPROVAL",
  policyVersion: APPROVAL_AFFORDABILITY_POLICY_VERSION,
  capturedAt: approvalAt,
  capturedById: "officer-1",
  inputs: {
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    applicationDebtCents: 0,
    clientDebtCents: 0,
    declaredDebtCents: 0,
    bureauObligationsCents: 0,
    proposedInstalmentCents: approvalCalculation.monthlyInstalment,
    principalCents: calculationInputs.principal,
    termDays: calculationInputs.termDays,
    productId: "product-1",
    interestRatePm: calculationInputs.interestRatePm,
    interestModel: calculationInputs.interestModel,
    initiationFeeModel: calculationInputs.initiationFeeModel,
    initiationFeePct: calculationInputs.initiationFeePct,
    initiationFeeMaxCents: calculationInputs.initiationFeeMax,
    monthlyServiceFeeCents: calculationInputs.monthlyServiceFee,
    initiationFeePayment: calculationInputs.initiationFeePayment,
    ndiBufferPct: 110,
  },
  applicationDebts: [],
  clientDebts: [],
  expenseEvidence: createAffordabilityExpenseEvidence({
    monthlyIncome: 2_000_000,
    monthlyExpenses: 800_000,
  }),
  bureauEvidence: null,
  calculation: approvalCalculation,
  calculationStartDate: approvalAt,
  outcome: {
    netDisposableIncomeCents: 1_200_000,
    ndiAfterLoanCents: 1_200_000 - approvalCalculation.monthlyInstalment,
    requiredNdiCents: Math.ceil(approvalCalculation.monthlyInstalment * 1.1),
    isAffordable: true,
    reason: null,
  },
})
const contract = createAffordabilityContractEvidence(approval, contractAt, {
  documentSha256: "a".repeat(64),
  calculator: approval.calculator,
})
const affordabilityResult = withAffordabilityContract(
  withAffordabilitySnapshot(null, approval),
  contract,
)
const application = {
  id: "app-1",
  status: "APPROVED",
  updatedAt: new Date("2026-07-20T09:05:00.000Z"),
  clientId: "client-1",
  productId: "product-1",
  appliedAmount: calculationInputs.principal,
  appliedTermDays: calculationInputs.termDays,
  bureauReviewGeneration: "review-generation-1",
  agreementGeneratedAt: contractAt,
  agreementDocumentId: "agreement-doc-1",
  agreementDocumentSha256: agreementPdfSha256,
  agreementSignedAt: null,
  agreementCountersignedAt: null,
  affordabilityResult,
  creditLifeElection: "DECLINED",
  creditLifeProductId: "credit-life-1",
  creditLifeProductName: "Acme Credit Life",
  creditLifeInsurerId: "insurer-1",
  creditLifeInsurerName: "Test Life",
  creditLifeMonthlyPremiumCents: 2_250,
  creditLifeDisclosureVersion: "credit-life-election-v1",
  creditLifeDisclosureSha256: createCreditLifeDisclosureSha256({
    version: "credit-life-election-v1",
    election: "DECLINED",
    principalCents: calculationInputs.principal,
    termDays: calculationInputs.termDays,
    monthlyPremiumCents: 2_250,
    productId: "credit-life-1",
    productName: "Acme Credit Life",
    insurerId: "insurer-1",
    insurerName: "Test Life",
  }),
  creditLifeDisclosureAcknowledgedAt: new Date("2026-07-18T08:55:00.000Z"),
  creditLifeDisclosureAcknowledgedBy: "client-1",
  pasqVersion: "pasq-v3",
  pasqGeneratedAt: approvalAt,
  pasqDocumentId: "pasq-doc-1",
  pasqDocumentSha256: "d".repeat(64),
  pasqEvidence: { version: "pasq-v3" },
  pasqEvidenceSha256: "e".repeat(64),
  pasqAcknowledgedAt: new Date("2026-07-18T09:05:00.000Z"),
  pasqAcknowledgedBy: "client-1",
  pasqAcknowledgedSha256: "d".repeat(64),
  approvedPasqDocumentSha256: "d".repeat(64),
}

function request(body: unknown) {
  // Every legitimate signer echoes the digest of the document it displayed;
  // tests inherit the fixture's digest unless they override it explicitly.
  const withEcho = typeof body === "object" && body !== null
    ? {
        agreementDocumentSha256: agreementPdfSha256,
        pasqDocumentSha256: "d".repeat(64),
        ...body,
      }
    : body
  return new NextRequest("http://localhost/api/applications/app-1/agreement/sign", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify(withEcho),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"))
  vi.clearAllMocks()
  verifyStoredPasqBindingMock.mockReset()
  verifyPasqDocumentArtifactMock.mockReset()
  authMock.mockResolvedValue({
    user: {
      id: "client-1",
      role: "CLIENT",
      email: "client@example.test",
      tenantId: "tenant-1",
    },
  })
  applicationFindUniqueMock.mockResolvedValue(application)
  agreementDocumentFindFirstMock.mockResolvedValue({
    id: "agreement-doc-1",
    storagePath: "/agreements/app-1.pdf",
    contentSha256: agreementPdfSha256,
  })
  txAgreementDocumentFindFirstMock.mockResolvedValue({
    id: "agreement-doc-1",
    storagePath: "/agreements/app-1.pdf",
    contentSha256: agreementPdfSha256,
  })
  readFileMock.mockResolvedValue(agreementPdf)
  bureauCheckFindFirstMock.mockResolvedValue({ id: "bureau-1" })
  tenantConfigFindUniqueMock.mockResolvedValue({
    ndiBufferPct: 110,
    bureauMinScore: 450,
    bureauBlockAdverse: false,
  })
  verifyCurrentAffordabilityApprovalMock.mockReturnValue({
    ok: true,
    approval,
    calculation: approvalCalculation,
  })
  verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
    ok: true,
    application,
    approval,
    calculation: approvalCalculation,
  })
  verifyStoredPasqBindingMock.mockReturnValue({
    ok: true,
    documentId: "pasq-doc-1",
    documentSha256: "d".repeat(64),
    evidence: {
      version: "pasq-v3",
      evidenceSha256: "e".repeat(64),
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
  txApplicationUpdateManyMock.mockResolvedValue({ count: 1 })
  txDocumentUpdateManyMock.mockResolvedValue({ count: 1 })
  txAuditCreateMock.mockResolvedValue({ id: "audit-1" })
  txQueryRawMock.mockResolvedValue([])
  txApplicationFindUniqueMock.mockResolvedValue({
    ...application,
    agreementSignedAt: new Date("2026-07-20T09:10:00.000Z"),
  })
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    loanApplication: {
      updateMany: txApplicationUpdateManyMock,
      findUnique: txApplicationFindUniqueMock,
    },
    clientDocument: {
      findFirst: txAgreementDocumentFindFirstMock,
      updateMany: txDocumentUpdateManyMock,
    },
    auditLog: { create: txAuditCreateMock },
    $queryRaw: txQueryRawMock,
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("identity must be established before the consumer is bound", () => {
  it("refuses to sign when the composite KYC gate rejects the locked approval", async () => {
    // Signing has always required payout-grade evidence, via
    // verifyLockedCurrentAffordabilityApproval -> hasCurrentCompositeKyc.
    // Origination was relaxed to allow a missing selfie; this is where that
    // stops. Asserted through the real gate's contract, not a bespoke branch.
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: false,
      reason: "kyc_changed",
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "kyc_changed",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })
})

describe("agreement signature evidence binding", () => {
  it("atomically acknowledges the exact PASQ and signs the agreement in one ceremony", async () => {
    const unacknowledged = {
      ...application,
      pasqAcknowledgedAt: null,
      pasqAcknowledgedBy: null,
      pasqAcknowledgedSha256: null,
      approvedPasqDocumentSha256: null,
    }
    applicationFindUniqueMock.mockResolvedValue(unacknowledged)
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true,
      application: unacknowledged,
      approval,
      calculation: approvalCalculation,
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(200)
    expect(verifyCurrentAffordabilityApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ requirePasqAcknowledgement: false }),
    )
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        pasqAcknowledgedAt: null,
        pasqAcknowledgedBy: null,
        pasqAcknowledgedSha256: null,
        approvedPasqDocumentSha256: null,
      }),
      data: expect.objectContaining({
        pasqAcknowledgedBy: "client-1",
        pasqAcknowledgedSha256: "d".repeat(64),
        approvedPasqDocumentSha256: "d".repeat(64),
        agreementSignedMethod: "portal",
      }),
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "pasq-doc-1",
        docType: "FORM_20_PRE_AGREEMENT",
      }),
      data: { signatureState: "acknowledged" },
    }))
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PASQ_ACKNOWLEDGED",
        newValue: expect.objectContaining({
          signingCeremony: "pasq_and_credit_agreement",
          documentSha256: "d".repeat(64),
        }),
      }),
    })
  })

  it("atomically signs the approved application, exact active document, and audit row", async () => {
    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(200)
    expect(bureauCheckFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        applicationId: "app-1",
        clientId: "client-1",
      }),
    }))
    expect(agreementDocumentFindFirstMock).toHaveBeenCalledWith({
      where: {
        id: "agreement-doc-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "CREDIT_AGREEMENT",
        fileName: "credit-agreement-app-1.pdf",
        deletedAt: null,
        storagePath: { not: null },
      },
      select: { id: true, storagePath: true, contentSha256: true },
    })
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "app-1",
        status: "APPROVED",
        updatedAt: application.updatedAt,
        agreementGeneratedAt: contractAt,
        agreementDocumentId: "agreement-doc-1",
        agreementDocumentSha256: agreementPdfSha256,
        agreementSignedAt: null,
        agreementCountersignedAt: null,
      }),
      data: expect.objectContaining({
        agreementSignedMethod: "portal",
        agreementSignatureData: "Jane Doe",
      }),
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "agreement-doc-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        deletedAt: null,
        contentSha256: agreementPdfSha256,
        verified: false,
      },
      data: expect.objectContaining({
        verified: true,
        signatureState: "signed",
        signedAt: expect.any(Date),
      }),
    }))
    expect(txDocumentUpdateManyMock.mock.calls[0][0].data.signedAt).toEqual(
      txApplicationUpdateManyMock.mock.calls[0][0].data.agreementSignedAt,
    )
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AGREEMENT_SIGNED",
        entityId: "app-1",
        newValue: expect.objectContaining({
          documentId: "agreement-doc-1",
          documentSha256: agreementPdfSha256,
          contractFingerprint: contract.fingerprint,
          pasqVersion: "pasq-v3",
          pasqDocumentId: "pasq-doc-1",
          pasqDocumentSha256: "d".repeat(64),
          pasqEvidenceSha256: "e".repeat(64),
          signatureSha256: expect.any(String),
        }),
      }),
    })
  })

  it("rejects signing when the approved PASQ bytes are tampered", async () => {
    verifyPasqDocumentArtifactMock.mockResolvedValue({
      ok: false,
      reason: "hash_mismatch",
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "pasq_changed",
      pasqDocument: "hash_mismatch",
    }))
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rechecks the approved PASQ under lock before recording a signature", async () => {
    verifyPasqDocumentArtifactMock
      .mockResolvedValueOnce({ ok: true, document: {}, bytes: Buffer.from("pasq") })
      .mockResolvedValueOnce({ ok: false, reason: "missing" })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "pasq_document_changed",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })

  it("does not let a client sign another client's agreement via the branch method", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "client-2",
        role: "CLIENT",
        email: "other@example.test",
        tenantId: "tenant-1",
      },
    })

    const response = await POST(request({ method: "branch", signature: "Other Person" }), context)

    expect(response.status).toBe(403)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects signing after the application has returned to review", async () => {
    applicationFindUniqueMock.mockResolvedValue({ ...application, status: "UNDER_REVIEW" })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(409)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("requires a portal signature artefact", async () => {
    const response = await POST(request({ method: "portal" }), context)

    expect(response.status).toBe(422)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("requires a drawn consumer artefact and staff witness attestation for branch signing", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "CREDIT_OFFICER",
        email: "officer@example.test",
        tenantId: "tenant-1",
      },
    })

    const typedResponse = await POST(request({
      method: "branch",
      signature: "Synthetic Customer",
      attestation: true,
    }), context)
    expect(typedResponse.status).toBe(422)
    expect((await typedResponse.json()).error).toMatch(/drawn signature/i)

    const unattestedResponse = await POST(request({
      method: "branch",
      signature: "data:image/png;base64,c2lnbmF0dXJl",
      attestation: false,
    }), context)
    expect(unattestedResponse.status).toBe(422)
    expect((await unattestedResponse.json()).error).toMatch(/attestation/i)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects a branch witness whose authenticated tenant differs from the application tenant", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "CREDIT_OFFICER",
        email: "officer@example.test",
        tenantId: "tenant-2",
      },
    })

    const response = await POST(request({
      method: "branch",
      signature: drawnSignature,
      attestation: true,
    }), context)

    expect(response.status).toBe(403)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("locks and records the active same-tenant branch witness", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "CREDIT_OFFICER",
        email: "officer@example.test",
        tenantId: "tenant-1",
      },
    })
    txQueryRawMock.mockResolvedValue([{
      id: "officer-1",
      email: "officer@example.test",
      name: "Credit Officer",
      role: "CREDIT_OFFICER",
    }])

    const response = await POST(request({
      method: "branch",
      signature: drawnSignature,
      attestation: true,
    }), context)

    expect(response.status).toBe(200)
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agreementSignedMethod: "branch",
        agreementSignedByUserId: "officer-1",
      }),
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verifiedById: "officer-1" }),
    }))
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "officer-1",
        userEmail: "officer@example.test",
        newValue: expect.objectContaining({
          branchWitnessAttested: true,
          branchWitnessId: "officer-1",
          branchWitnessName: "Credit Officer",
          branchWitnessEmail: "officer@example.test",
        }),
      }),
    })
  })

  it("records a complete returned signed PDF as the branch signature artifact", async () => {
    authMock.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "CREDIT_OFFICER",
        email: "officer@example.test",
        tenantId: "tenant-1",
      },
    })
    txQueryRawMock.mockResolvedValue([{
      id: "officer-1",
      email: "officer@example.test",
      name: "Credit Officer",
      role: "CREDIT_OFFICER",
    }])
    const returnedDocument = {
      id: "signed-packet-1",
      storagePath: "/signed-packets/app-1.pdf",
      contentSha256: returnedPacketSha256,
      validationResult: {
        version: "signed-pasq-credit-agreement-v1",
        applicationId: "app-1",
        pasqDocumentId: "pasq-doc-1",
        pasqDocumentSha256: "d".repeat(64),
        agreementDocumentId: "agreement-doc-1",
        agreementDocumentSha256: agreementPdfSha256,
      },
    }
    agreementDocumentFindFirstMock.mockImplementation((args: {
      where?: { id?: string }
    }) => args.where?.id === "signed-packet-1"
      ? Promise.resolve(returnedDocument)
      : Promise.resolve({
          id: "agreement-doc-1",
          storagePath: "/agreements/app-1.pdf",
          contentSha256: agreementPdfSha256,
        }))
    txAgreementDocumentFindFirstMock.mockImplementation((args: {
      where?: { id?: string }
    }) => args.where?.id === "signed-packet-1"
      ? Promise.resolve(returnedDocument)
      : Promise.resolve({
          id: "agreement-doc-1",
          storagePath: "/agreements/app-1.pdf",
          contentSha256: agreementPdfSha256,
        }))
    readFileMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes("signed-packets") ? returnedPacketPdf : agreementPdf,
      ))

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(200)
    expect(txApplicationUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agreementSignedMethod: "branch",
        agreementSignedByUserId: "officer-1",
        agreementSignatureData:
          `signed-packet-v1:signed-packet-1:${returnedPacketSha256}`,
      }),
    }))
    expect(txDocumentUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "signed-packet-1",
        signatureState: "returned_pending_recording",
      }),
      data: expect.objectContaining({
        verified: true,
        signatureState: "signed_returned_packet",
      }),
    }))
    expect(txAuditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SIGNED_PACKET_RECORDED",
        newValue: expect.objectContaining({
          signedPacketDocumentId: "signed-packet-1",
          signedPacketSha256: returnedPacketSha256,
        }),
      }),
    })
  })

  // Wires up a returned signed packet exactly as the panel does. Shared by the
  // two tests below so the difference between them is only the date.
  function arrangeReturnedPacket() {
    authMock.mockResolvedValue({
      user: {
        id: "officer-1",
        role: "CREDIT_OFFICER",
        email: "officer@example.test",
        tenantId: "tenant-1",
      },
    })
    txQueryRawMock.mockResolvedValue([{
      id: "officer-1",
      email: "officer@example.test",
      name: "Credit Officer",
      role: "CREDIT_OFFICER",
    }])
    const returnedDocument = {
      id: "signed-packet-1",
      storagePath: "/signed-packets/app-1.pdf",
      contentSha256: returnedPacketSha256,
      validationResult: {
        version: "signed-pasq-credit-agreement-v1",
        applicationId: "app-1",
        pasqDocumentId: "pasq-doc-1",
        pasqDocumentSha256: "d".repeat(64),
        agreementDocumentId: "agreement-doc-1",
        agreementDocumentSha256: agreementPdfSha256,
      },
    }
    const byId = (args: { where?: { id?: string } }) =>
      args.where?.id === "signed-packet-1"
        ? Promise.resolve(returnedDocument)
        : Promise.resolve({
            id: "agreement-doc-1",
            storagePath: "/agreements/app-1.pdf",
            contentSha256: agreementPdfSha256,
          })
    agreementDocumentFindFirstMock.mockImplementation(byId)
    txAgreementDocumentFindFirstMock.mockImplementation(byId)
    readFileMock.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes("signed-packets") ? returnedPacketPdf : agreementPdf,
      ))
  }

  // The defect these two tests pin. A consumer signs the printed packet on the
  // day the agreement was established; the branch scans it back the next
  // morning. Without a signature date the route stamps "now", so the schedule
  // gate judges a 20 July contract against 21 July and refuses -- leaving
  // agreementSignedAt NULL, which then lets regeneration supersede a document
  // the consumer has already signed. Recording the real date is the whole fix:
  // the gate is already evaluated at the signature instant, so handing it the
  // true one makes it compare like with like.
  it("refuses a packet returned the next day when no signature date is given", async () => {
    arrangeReturnedPacket()
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"))

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/no longer current/i)
  })

  // The whole point of the 2026-08-07 scoping. An EFT loan has no debit mandate
  // fixing collection dates in advance, so the ceremony no longer has to finish
  // on the day the agreement was established — s92(3) is the only bound. This is
  // the case that produced two ledger exceptions: signed on paper on the
  // established day, scanned back the next morning.
  //
  // Its twin above (no repaymentMethod on the fixture) still refuses, which is
  // what proves the scoping is doing the work rather than the clamp simply
  // having been deleted.
  it("records an EFT packet returned the next day even without a signature date", async () => {
    arrangeReturnedPacket()
    const eftApplication = { ...application, repaymentMethod: "EFT" }
    applicationFindUniqueMock.mockResolvedValue(eftApplication)
    // The in-transaction re-check reads the application through the locked
    // approval helper, so the method has to be present on BOTH reads or the
    // route admits at the gate and then refuses under lock.
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: true, application: eftApplication, approval, calculation: approvalCalculation,
    })
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"))

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(200)
  })

  it("still refuses a DEBIT_ORDER packet returned the next day", async () => {
    arrangeReturnedPacket()
    applicationFindUniqueMock.mockResolvedValue({
      ...application, repaymentMethod: "DEBIT_ORDER",
    })
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"))

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/no longer current/i)
  })

  it("records a packet returned the next day at the date the consumer signed", async () => {
    arrangeReturnedPacket()
    vi.setSystemTime(new Date("2026-07-21T10:00:00.000Z"))
    // The agreement was established 2026-07-20 (contractAt), which is the day
    // the consumer signed the paper.
    expect(southAfricanCalendarDate(contractAt)).toBe("2026-07-20")

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedOn: "2026-07-20",
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(200)
    const persistedSignedAt = txApplicationUpdateManyMock.mock.calls[0][0].data
      .agreementSignedAt as Date
    expect(southAfricanCalendarDate(persistedSignedAt)).toBe("2026-07-20")
    // Not the day it was keyed in -- that was the false timestamp.
    expect(southAfricanCalendarDate(persistedSignedAt))
      .not.toBe(southAfricanCalendarDate(new Date()))
  })

  it("refuses a signature date in the future", async () => {
    arrangeReturnedPacket()
    vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"))

    const response = await POST(request({
      method: "branch",
      attestation: true,
      signedOn: "2026-07-21",
      signedPacketDocumentId: "signed-packet-1",
      signedPacketSha256: returnedPacketSha256,
    }), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/signature date/i)
  })

  it("fails closed for a legacy generated agreement without a byte binding", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...application,
      agreementDocumentId: null,
      agreementDocumentSha256: null,
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "binding_missing",
    }))
    expect(agreementDocumentFindFirstMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects signing when current decision inputs no longer match approval", async () => {
    verifyCurrentAffordabilityApprovalMock.mockReturnValue({
      ok: false,
      reason: "changed",
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      affordabilitySnapshot: "changed",
    }))
    expect(agreementDocumentFindFirstMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects changed agreement bytes before opening the signing transaction", async () => {
    readFileMock.mockResolvedValue(Buffer.from("%PDF-1.4 changed"))

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "content_mismatch",
    }))
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rolls back when agreement bytes change after the preflight check", async () => {
    readFileMock
      .mockResolvedValueOnce(agreementPdf)
      .mockResolvedValueOnce(Buffer.from("%PDF-1.4 changed during signing"))

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "agreement_document_bytes",
    }))
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })

  it("rejects an expired contract schedule before marking the document signed", async () => {
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"))

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toMatch(/no longer current/i)
    expect(agreementDocumentFindFirstMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  // Every judgement in this route -- the pre-transaction schedule gate, the
  // re-check under lock, and the agreementSignedAt stamp -- must come from ONE
  // reading of the clock. Take the reading more than once and a ceremony that
  // begins at 23:59 SAST can have its readings land on different SAST days, at
  // which point the gates disagree about whether the very same contract is
  // signable. Mutation-verified: reverting to two independent `new Date()`
  // reads turns this case into a 409, i.e. a consumer who signs just before
  // midnight is refused for no reason they can see or fix.
  //
  // Freezing the clock once (as every other test in this file does) cannot
  // catch that, because two identical readings are indistinguishable from one.
  // So the clock is pushed across the SAST midnight boundary by a mock the
  // route calls AFTER the gate, reproducing the race deterministically.
  it("stamps the signature at the instant the schedule gate approved, not a later one", async () => {
    // 23:59:30 SAST on the contract's own established day: the gate passes.
    vi.setSystemTime(new Date("2026-07-20T21:59:30.000Z"))
    expect(southAfricanCalendarDate(new Date("2026-07-20T21:59:30.000Z")))
      .toBe(southAfricanCalendarDate(contractAt))

    // Called by the route after the gate. Advancing here crosses into the next
    // SAST day (22:00:00Z == 00:00 SAST), so any clock read after this point
    // belongs to a day the gate never approved.
    agreementDocumentFindFirstMock.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-07-20T22:01:30.000Z"))
      return {
        id: "agreement-doc-1",
        storagePath: "/agreements/app-1.pdf",
        contentSha256: agreementPdfSha256,
      }
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(200)
    const persistedSignedAt = txApplicationUpdateManyMock.mock.calls[0][0].data
      .agreementSignedAt as Date
    expect(persistedSignedAt).toBeInstanceOf(Date)
    // Confirms the advance actually happened -- otherwise this test would pass
    // vacuously against a clock that never moved.
    expect(southAfricanCalendarDate(new Date())).not.toBe(
      southAfricanCalendarDate(contractAt),
    )
    expect(southAfricanCalendarDate(persistedSignedAt)).toBe(
      southAfricanCalendarDate(contractAt),
    )
  })

  it("rolls back and returns 409 when return-to-review wins the application race", async () => {
    txApplicationUpdateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(409)
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })

  it("rechecks locked affordability evidence before recording the signature", async () => {
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: false,
      reason: "changed",
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(409)
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })

  it("returns a distinct remediation when KYC changes after the preflight check", async () => {
    verifyLockedCurrentAffordabilityApprovalMock.mockResolvedValue({
      ok: false,
      reason: "kyc_changed",
    })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "The client's KYC evidence no longer meets the identity bar for signing.",
      affordabilitySnapshot: "kyc_changed",
      remediation: "Capture a selfie or record an in-person verification on the client's KYC tab. If a verified document itself changed, return the application to review and re-verify, then generate a new agreement before signing.",
    })
    expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    expect(txDocumentUpdateManyMock).not.toHaveBeenCalled()
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })

  it("rolls back and returns an integrity error when the exact agreement document changes", async () => {
    txDocumentUpdateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request({ method: "portal", signature: "Jane Doe" }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "agreement_document_changed",
    }))
    expect(txAuditCreateMock).not.toHaveBeenCalled()
  })
})

describe("signature-to-document binding (regeneration safety)", () => {
  it("refuses a signature whose echoed digest no longer matches the bound document", async () => {
    const response = await POST(request({
      method: "portal",
      signature: "data:image/png;base64,AAAA",
      agreementDocumentSha256: "0".repeat(64),
    }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "document_changed",
    }))
  })

  it("refuses a signer that cannot say which document it displayed", async () => {
    const response = await POST(request({
      method: "portal",
      signature: "data:image/png;base64,AAAA",
      agreementDocumentSha256: undefined,
    }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      agreementIntegrity: "document_changed",
    }))
  })
})
