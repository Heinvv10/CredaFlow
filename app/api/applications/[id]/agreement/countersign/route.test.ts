import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

const {
  requireApiRoleMock,
  applicationFindUniqueMock,
  transactionMock,
  verifyLockedApprovalMock,
  verifyCreditLifeMock,
  verifyPasqBindingMock,
  verifyPasqArtifactMock,
  documentFindFirstMock,
  queryRawMock,
  updateManyMock,
  auditCreateMock,
  readFileMock,
  userFindFirstMock,
  preflightDocumentFindFirstMock,
  complianceFindFirstMock,
  applicationFindFirstMock,
  documentCreateMock,
  saveFileMock,
  deleteFileMock,
  stampMock,
  tenantFindUniqueMock,
  clientFindFirstMock,
  canBeDisbursedMock,
  sodRequiredMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  verifyLockedApprovalMock: vi.fn(),
  verifyCreditLifeMock: vi.fn(),
  verifyPasqBindingMock: vi.fn(),
  verifyPasqArtifactMock: vi.fn(),
  documentFindFirstMock: vi.fn(),
  queryRawMock: vi.fn(),
  updateManyMock: vi.fn(),
  auditCreateMock: vi.fn(),
  readFileMock: vi.fn(),
  userFindFirstMock: vi.fn(),
  preflightDocumentFindFirstMock: vi.fn(),
  complianceFindFirstMock: vi.fn(),
  applicationFindFirstMock: vi.fn(),
  documentCreateMock: vi.fn(),
  saveFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
  stampMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  clientFindFirstMock: vi.fn(),
  canBeDisbursedMock: vi.fn(),
  sodRequiredMock: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => unknown) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findUnique: (...args: unknown[]) => applicationFindUniqueMock(...args),
      findFirst: (...args: unknown[]) => applicationFindFirstMock(...args),
    },
    user: { findFirst: (...args: unknown[]) => userFindFirstMock(...args) },
    tenant: { findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args) },
    client: { findFirst: (...args: unknown[]) => clientFindFirstMock(...args) },
    clientDocument: {
      findFirst: (...args: unknown[]) => preflightDocumentFindFirstMock(...args),
    },
    complianceRecord: {
      findFirst: (...args: unknown[]) => complianceFindFirstMock(...args),
    },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}))
vi.mock("@/lib/affordability/current-approval", () => ({
  verifyLockedCurrentAffordabilityApproval: (...args: unknown[]) =>
    verifyLockedApprovalMock(...args),
}))
vi.mock("@/lib/affordability/snapshot", () => ({
  readAffordabilitySnapshotStore: () => ({ contract: { fingerprint: "contract-fp", establishedAt: "2026-07-23T08:00:00.000Z" } }),
  affordabilityContractEvidenceIsIntact: () => true,
  affordabilityContractCanBeDisbursed: (...args: unknown[]) => canBeDisbursedMock(...args),
}))
vi.mock("@/lib/insurance/credit-life-election.server", () => ({
  verifyStoredCreditLifeDisclosure: (...args: unknown[]) => verifyCreditLifeMock(...args),
}))
vi.mock("@/lib/compliance/pasq", () => ({
  verifyStoredPasqBinding: (...args: unknown[]) => verifyPasqBindingMock(...args),
}))
vi.mock("@/lib/compliance/pasq-document.server", () => ({
  verifyPasqDocumentArtifact: (...args: unknown[]) => verifyPasqArtifactMock(...args),
}))
vi.mock("@/lib/storage", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
  managedStoragePath: (key: string) => `/managed/${key}.pdf`,
  saveFileToManagedPath: (...args: unknown[]) => saveFileMock(...args),
  deleteManagedFileStrict: (...args: unknown[]) => deleteFileMock(...args),
}))
// The stamping itself is proved against real rendered PDFs in
// lib/pdf/__tests__/executed-agreement.test.ts. Here it is mocked so this file
// can keep asserting what the ROUTE does — which evidence it hands to the
// stamper, and what it records — against a fixture that is not a real PDF.
vi.mock("@/lib/pdf/executed-agreement", () => ({
  stampExecutedAgreement: (...args: unknown[]) => stampMock(...args),
  readAgreementSignatureAnchors: (value: unknown) => value ?? null,
  // Real implementation, not a stub: the route uses it to decide whether an
  // execution page (and therefore provider identity) is needed at all.
  isReturnedPacketReference: (artefact: string) => artefact.startsWith("signed-packet-v1:"),
}))
vi.mock("@/lib/compliance/statutory-provider-identity.server", async () => {
  const { ACME_LENDER } = await import("@/lib/config/__fixtures__/lender-identity")
  return {
    statutoryProviderIdentityFromTenant: (tenant: { name?: string } | null) =>
      tenant ? { tenantName: ACME_LENDER.legalName, statutoryNcrNumber: ACME_LENDER.ncrNumber } : null,
  }
})
vi.mock("@/lib/audit", () => ({
  AuditAction: { AGREEMENT_PROVIDER_COUNTERSIGNED: "AGREEMENT_PROVIDER_COUNTERSIGNED" },
}))

vi.mock("@/lib/security/segregation-of-duties", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/segregation-of-duties")>(),
  isSegregationOfDutiesRequired: (...args: unknown[]) => sodRequiredMock(...args),
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "app-1" }) }
const agreementBytes = Buffer.from("%PDF-1.4 exact signed agreement")
const agreementSha256 = sha256DocumentBytes(agreementBytes)
const generatedAt = new Date("2026-07-23T08:00:00.000Z")
const signedAt = new Date("2026-07-23T08:30:00.000Z")
const updatedAt = new Date("2026-07-23T08:31:00.000Z")
const current = {
  id: "app-1",
  tenantId: "tenant-1",
  clientId: "client-1",
  productId: "product-1",
  status: "APPROVED",
  updatedAt,
  appliedAmount: 500_000,
  appliedTermDays: 30,
  affordabilityResult: {},
  repaymentMethod: "EFT",
  agreementGeneratedAt: generatedAt,
  agreementDocumentId: "agreement-doc-1",
  agreementDocumentSha256: agreementSha256,
  agreementSignedAt: signedAt,
  agreementSignedMethod: "portal",
  agreementSignedByUserId: null,
  agreementSignatureData: "Synthetic Customer",
  agreementCountersignedAt: null,
}
const preflight = {
  id: current.id,
  status: current.status,
  updatedAt,
  agreementGeneratedAt: generatedAt,
  agreementDocumentId: current.agreementDocumentId,
  agreementDocumentSha256: agreementSha256,
  agreementSignedAt: signedAt,
  agreementSignedMethod: "portal",
  agreementSignedByUserId: null,
  agreementSignatureData: "Synthetic Customer",
  agreementCountersignedAt: null,
  agreementExecutedDocumentId: null,
  pasqEvidenceSha256: "e".repeat(64),
  reference: "APP-001",
}

const executedBytes = Buffer.from("%PDF-1.4 executed agreement with both signatures")
const executedSha256 = sha256DocumentBytes(executedBytes)
const anchors = {
  pageIndex: 3,
  fontSize: 9,
  consumer: { signatureX: 131, signatureWidth: 155, dateX: 314, dateWidth: 75, baselineY: 603 },
  provider: { signatureX: 171, signatureWidth: 100, dateX: 299, dateWidth: 75, baselineY: 531 },
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/applications/app-1/agreement/countersign", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7, 127.0.0.1" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("TRUSTED_PROXY", "1")
  verifyPasqArtifactMock.mockReset()
  queryRawMock.mockReset()
  requireApiRoleMock.mockResolvedValue({
    user: {
      id: "staff-1",
      email: "jane@example.test",
      name: "Jane Provider",
      role: "LOAN_ADMIN",
      tenantId: "tenant-1",
    },
  })
  applicationFindUniqueMock.mockResolvedValue(preflight)
  canBeDisbursedMock.mockReturnValue(true)
  sodRequiredMock.mockResolvedValue(true)
  verifyLockedApprovalMock.mockResolvedValue({
    ok: true,
    application: current,
    approval: { calculator: { pricingFingerprint: "pricing-fp" } },
  })
  verifyCreditLifeMock.mockReturnValue({
    ok: true,
    evidence: { disclosureSha256: "c".repeat(64) },
  })
  verifyPasqBindingMock.mockReturnValue({
    ok: true,
    documentId: "pasq-doc-1",
    documentSha256: "d".repeat(64),
    evidence: { evidenceSha256: "e".repeat(64) },
  })
  verifyPasqArtifactMock.mockResolvedValue({ ok: true, document: {}, bytes: Buffer.from("pasq") })
  documentFindFirstMock.mockResolvedValue({
    id: "agreement-doc-1",
    storagePath: "/agreements/app-1.pdf",
    contentSha256: agreementSha256,
  })
  queryRawMock.mockImplementation((query: { strings?: readonly string[] }) => {
    const sql = query?.strings?.join(" ") ?? String(query)
    if (sql.includes('FROM "User"')) {
      return Promise.resolve([{
        id: "staff-1",
        email: "jane@example.test",
        name: "Jane Provider",
        role: "LOAN_ADMIN",
      }])
    }
    if (sql.includes('FROM "ClientDocument"')) {
      return Promise.resolve([{ id: "agreement-doc-1" }])
    }
    return Promise.resolve([{ id: "artifact-1" }])
  })
  updateManyMock.mockResolvedValue({ count: 1 })
  auditCreateMock.mockResolvedValue({ id: "audit-1" })
  userFindFirstMock.mockResolvedValue({
    id: "staff-1",
    email: "jane@example.test",
    name: "Jane Provider",
    role: "LOAN_ADMIN",
  })
  preflightDocumentFindFirstMock.mockResolvedValue({
    id: "agreement-doc-1",
    storagePath: "/agreements/app-1.pdf",
  })
  complianceFindFirstMock.mockResolvedValue({
    id: "artifact-1",
    data: { kind: "CREDIT_AGREEMENT_ARTIFACT", signatureAnchors: anchors },
  })
  applicationFindFirstMock.mockResolvedValue(null)
  documentCreateMock.mockResolvedValue({ id: "executed-doc-1" })
  stampMock.mockResolvedValue({
    bytes: executedBytes,
    method: "stamped",
    consumerSignatureRendered: true,
    providerSignatureRendered: true,
  })
  tenantFindUniqueMock.mockResolvedValue({ id: "tenant-1", name: "Acme Lending (Pty) Ltd", config: {} })
  clientFindFirstMock.mockResolvedValue({
    firstName: "Synthetic", lastName: "Customer", idNumber: "8503015000083",
  })
  saveFileMock.mockImplementation(async (bytes: Buffer, _mime: string, key: string) => ({
    storagePath: `/managed/${key}.pdf`,
    fileSize: bytes.length,
  }))
  deleteFileMock.mockResolvedValue(undefined)
  // The stored agreement is read first, then the executed artifact is read back
  // out of managed storage to prove the write landed.
  readFileMock.mockImplementation(async (path: string) =>
    path === "/agreements/app-1.pdf" ? agreementBytes : executedBytes)
  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    loanApplication: { updateMany: updateManyMock },
    clientDocument: { findFirst: documentFindFirstMock, create: documentCreateMock },
    auditLog: { create: auditCreateMock },
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("provider agreement countersign", () => {
  it("rejects an authenticated staff principal assigned to another tenant", async () => {
    requireApiRoleMock.mockResolvedValue({
      user: {
        id: "staff-other",
        email: "other@example.test",
        name: "Other Tenant Officer",
        role: "LOAN_ADMIN",
        tenantId: "tenant-2",
      },
    })

    const response = await POST(
      request({ signature: "Other Tenant Officer", attestation: true }),
      context,
    )

    expect(response.status).toBe(403)
    expect(applicationFindUniqueMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("records complete exact-document evidence and audit atomically", async () => {
    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(verifyPasqArtifactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ documentId: "pasq-doc-1", lock: true }),
    )
    expect(documentFindFirstMock).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "agreement-doc-1",
        verified: true,
        signatureState: "signed",
        signedAt,
        contentSha256: agreementSha256,
      }),
      select: { id: true, storagePath: true, contentSha256: true },
    })
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        agreementDocumentSha256: agreementSha256,
        agreementSignedAt: signedAt,
        agreementSignedMethod: "portal",
        agreementSignatureData: "Synthetic Customer",
        agreementCountersignedAt: null,
      }),
      data: expect.objectContaining({
        agreementCountersignedById: "staff-1",
        agreementCountersignedByName: "Jane Provider",
        agreementCountersignedByEmail: "jane@example.test",
        agreementCountersignatureData: "Jane Provider",
        agreementCountersignatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        agreementCountersignatureEnvelopeSha256:
          expect.stringMatching(/^[0-9a-f]{64}$/),
        agreementCountersignedDocumentSha256: agreementSha256,
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "AGREEMENT_PROVIDER_COUNTERSIGNED",
        entityId: "app-1",
        newValue: expect.objectContaining({
          documentSha256: agreementSha256,
          consumerSignatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          signatureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          envelopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          pasqDocumentSha256: "d".repeat(64),
        }),
        ipAddress: "127.0.0.1",
      }),
    })
  })

  it("requires an affirmative signature attestation", async () => {
    const response = await POST(request({ signature: "Jane Provider", attestation: false }), context)

    expect(response.status).toBe(422)
    expect(applicationFindUniqueMock).not.toHaveBeenCalled()
  })

  it("does not allow countersigning before the consumer signs", async () => {
    applicationFindUniqueMock.mockResolvedValue({ ...preflight, agreementSignedAt: null })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(422)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("does not countersign a branch record without a consumer signature artefact", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...preflight,
      agreementSignedMethod: "branch",
      agreementSignedByUserId: "staff-2",
      agreementSignatureData: null,
    })

    const response = await POST(
      request({ signature: "Jane Provider", attestation: true }),
      context,
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "consumer_signature_missing",
    }))
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("does not allow a second countersign", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...preflight,
      agreementCountersignedAt: new Date("2026-07-23T08:45:00.000Z"),
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("returns the role guard response without reading application data", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(403)
    expect(applicationFindUniqueMock).not.toHaveBeenCalled()
  })

  it("fails closed when locked approval or PASQ evidence changes", async () => {
    verifyLockedApprovalMock.mockResolvedValue({ ok: false, reason: "pasq_changed" })

    const approvalResponse = await POST(request({ signature: "Jane Provider", attestation: true }), context)
    expect(approvalResponse.status).toBe(409)
    expect(await approvalResponse.json()).toEqual(expect.objectContaining({
      countersignEvidence: "pasq_changed",
    }))

    verifyLockedApprovalMock.mockResolvedValue({
      ok: true,
      application: current,
      approval: { calculator: { pricingFingerprint: "pricing-fp" } },
    })
    verifyPasqArtifactMock.mockResolvedValue({ ok: false, reason: "hash_mismatch" })
    const artifactResponse = await POST(request({ signature: "Jane Provider", attestation: true }), context)
    expect(artifactResponse.status).toBe(422)
    expect(await artifactResponse.json()).toEqual(expect.objectContaining({
      countersignEvidence: "pasq_document_changed",
    }))
  })

  it("rolls back when signed agreement bytes are tampered", async () => {
    readFileMock.mockResolvedValue(Buffer.from("tampered"))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "agreement_document_bytes",
    }))
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("returns 409 and writes no audit when another request wins the countersign race", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "application_changed",
    }))
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  // The disbursability gate is scoped to how the loan will be collected, so the
  // repayment method is now an INPUT to a compliance decision. Nothing in this
  // file could see it before: the helper was stubbed `() => true`, which reports
  // the same answer whichever value the route reads.
  it("scopes the disbursability check to the LOCKED repayment method", async () => {
    verifyLockedApprovalMock.mockResolvedValue({
      ok: true,
      application: { ...current, repaymentMethod: "DEBIT_ORDER" },
      approval: { calculator: { pricingFingerprint: "pricing-fp" } },
    })

    await POST(request({ signature: "Jane Provider", attestation: true }), context)

    // Third argument, not "was called": the value has to come from the row read
    // under the lock. Reading the pre-transaction copy instead yields "EFT" here
    // and fails. That the two can only differ in a fixture is the point — the
    // check should not depend on a same-transaction guarantee enforced in
    // decide/route.ts to be reading the right row.
    expect(canBeDisbursedMock).toHaveBeenCalledWith(
      expect.anything(), expect.any(Date), "DEBIT_ORDER",
    )
  })

  it("refuses the countersignature when the contract cannot be disbursed", async () => {
    canBeDisbursedMock.mockReturnValue(false)

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "contract_changed",
    }))
    expect(auditCreateMock).not.toHaveBeenCalled()
  })
})

// ── The executed artifact ────────────────────────────────────────────────────
//
// Until this shipped, NO signature event changed the agreement's bytes: the
// consumer signed in the portal, the row flipped to signatureState 'signed',
// and the stored PDF still showed a blank signature line. These tests exist to
// keep that from silently returning.
describe("provider agreement countersign — executed artifact", () => {
  it("stamps the STORED agreement with both signatures and binds the result", async () => {
    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)
    expect(response.status).toBe(200)

    // Stamped onto the exact bytes that were read back and digest-checked
    // against agreementDocumentSha256 — not onto a fresh render.
    expect(stampMock).toHaveBeenCalledWith(expect.objectContaining({
      agreementBytes,
      anchors,
      execution: expect.objectContaining({
        consumerSignature: "Synthetic Customer",
        consumerSignedAt: signedAt,
        providerSignature: "Jane Provider",
        providerName: "Jane Provider",
      }),
      // Same per-ceremony reference the agreement's own pages carry.
      ceremonyMarker: "e".repeat(64).slice(0, 12),
    }))

    expect(documentCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        docType: "EXECUTED_CREDIT_AGREEMENT",
        clientId: "client-1",
        contentSha256: executedSha256,
        mimeType: "application/pdf",
        verified: true,
        signatureState: "signed",
      }),
    })

    // Bound in the SAME statement as the countersignature: a countersigned
    // application with no executed agreement must be unrepresentable.
    const update = updateManyMock.mock.calls[0][0]
    expect(update.data).toEqual(expect.objectContaining({
      agreementExecutedDocumentSha256: executedSha256,
    }))
    expect(update.data.agreementExecutedDocumentId)
      .toBe(documentCreateMock.mock.calls[0][0].data.id)
    // ...and the predicate is what makes it exclusive, not a prior read.
    expect(update.where).toEqual(expect.objectContaining({
      agreementExecutedDocumentId: null,
      agreementCountersignedAt: null,
    }))
  })

  it("records the executed artifact in the audit trail, method included", async () => {
    await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          executedDocumentSha256: executedSha256,
          executedArtifactMethod: "stamped",
        }),
      }),
    }))
  })

  it("refuses outright when an executed agreement already exists", async () => {
    applicationFindUniqueMock.mockResolvedValue({
      ...preflight,
      agreementExecutedDocumentId: "executed-doc-existing",
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(stampMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
  })

  it("appends an execution page for an agreement generated before anchors existed", async () => {
    complianceFindFirstMock.mockResolvedValue({
      id: "artifact-1",
      data: { kind: "CREDIT_AGREEMENT_ARTIFACT" },
    })
    stampMock.mockResolvedValue({
      bytes: executedBytes,
      method: "execution_page",
      consumerSignatureRendered: true,
      providerSignatureRendered: true,
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
    // Null, not undefined and not a guessed coordinate: the stamper must be
    // told there are no anchors so it appends a page instead.
    expect(stampMock.mock.calls[0][0].anchors).toBeNull()
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        newValue: expect.objectContaining({ executedArtifactMethod: "execution_page" }),
      }),
    }))
  })

  it("refuses when the artifact record that supplied the anchors is not the one locked", async () => {
    // The anchors came from one compliance record; a different one is live.
    queryRawMock.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join(" ") ?? String(query)
      if (sql.includes('FROM "User"')) {
        return Promise.resolve([{
          id: "staff-1", email: "jane@example.test", name: "Jane Provider", role: "LOAN_ADMIN",
        }])
      }
      if (sql.includes('FROM "ClientDocument"')) return Promise.resolve([{ id: "agreement-doc-1" }])
      return Promise.resolve([{ id: "artifact-SOMETHING-ELSE" }])
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "agreement_artifact_changed",
    }))
    expect(updateManyMock).not.toHaveBeenCalled()
    // The staged bytes must not be left behind.
    expect(deleteFileMock).toHaveBeenCalled()
  })

  it("refuses when the representative is renamed between the render and the lock", async () => {
    // The document was stamped "Jane Provider"; the locked row now says
    // otherwise. Committing would leave the artifact and the audit record
    // disagreeing about who countersigned.
    queryRawMock.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join(" ") ?? String(query)
      if (sql.includes('FROM "User"')) {
        return Promise.resolve([{
          id: "staff-1", email: "jane@example.test", name: "Jane RENAMED", role: "LOAN_ADMIN",
        }])
      }
      if (sql.includes('FROM "ClientDocument"')) return Promise.resolve([{ id: "agreement-doc-1" }])
      return Promise.resolve([{ id: "artifact-1" }])
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "provider_signer_tenant_changed",
    }))
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("refuses when managed storage returns different bytes than were stamped", async () => {
    readFileMock.mockImplementation(async (path: string) =>
      path === "/agreements/app-1.pdf" ? agreementBytes : Buffer.from("%PDF-1.4 something else"))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "executed_artifact_storage",
    }))
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("discards the staged bytes when the countersignature does not commit", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    // The exact path that was written, not merely "some string".
    const writtenKey = saveFileMock.mock.calls[0][2] as string
    expect(deleteFileMock).toHaveBeenCalledWith(`/managed/${writtenKey}.pdf`)
    expect(documentCreateMock).not.toHaveBeenCalled()
  })

  it("removes the staged bytes when the storage read-back fails, leaving no orphan", async () => {
    // The orphan would be a full credit agreement carrying the consumer's
    // signature, ID number and address, with no ClientDocument row and no audit
    // row — reachable by no DSAR and no POPIA erasure path, because nothing
    // references it.
    readFileMock.mockImplementation(async (path: string) =>
      path === "/agreements/app-1.pdf" ? agreementBytes : Buffer.from("%PDF-1.4 tampered"))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(422)
    const writtenKey = saveFileMock.mock.calls[0][2] as string
    expect(deleteFileMock).toHaveBeenCalledWith(`/managed/${writtenKey}.pdf`)
  })

  it("reports an orphan when the staged bytes cannot be removed either", async () => {
    readFileMock.mockImplementation(async (path: string) =>
      path === "/agreements/app-1.pdf" ? agreementBytes : Buffer.from("%PDF-1.4 tampered"))
    deleteFileMock.mockRejectedValue(new Error("storage unavailable"))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "executed_artifact_orphaned",
    }))
  })

  it("refuses rather than emitting an execution page that names no credit provider", async () => {
    // An appended page is attributable only by the identifiers printed on it.
    // Anchors absent => the execution page path => identity is required.
    complianceFindFirstMock.mockResolvedValue({
      id: "artifact-1",
      data: { kind: "CREDIT_AGREEMENT_ARTIFACT" },
    })
    tenantFindUniqueMock.mockResolvedValue(null)

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    // 503, not 422: this is a tenant configuration gap, and the 422 remedy
    // ("return the application to review") would re-paper the loan and void
    // the consumer's signature without fixing anything.
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "provider_identity_missing",
    }))
    expect(stampMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
  })

  it("does NOT require provider identity on the stamped path", async () => {
    // Identity is printed only on an appended page. Demanding it always would
    // let one missing TenantConfig row block every countersignature in the
    // tenant — and the error would send staff to re-paper the loan.
    tenantFindUniqueMock.mockResolvedValue(null)

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
    expect(stampMock).toHaveBeenCalled()
  })

  it("hands the stamper the provider identity on the stamped path too, when it is configured", async () => {
    // Stored anchors can still fail to locate a page (an out-of-range index),
    // in which case the stamper appends an execution page after all. That page
    // must name the provider, not fail as if the lender were unconfigured.
    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
    expect(stampMock.mock.calls[0][0].anchors).not.toBeNull()
    expect(stampMock.mock.calls[0][0].identity).toEqual(expect.objectContaining({
      lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
    }))
  })

  it("records when the consumer's signature could not be rendered", async () => {
    stampMock.mockResolvedValue({
      bytes: executedBytes,
      method: "execution_page",
      consumerSignatureRendered: false,
      providerSignatureRendered: true,
    })

    await POST(request({ signature: "Jane Provider", attestation: true }), context)

    // Otherwise a document that evidences nothing looks identical in the audit
    // trail to one that evidences a signature.
    expect(auditCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        newValue: expect.objectContaining({
          executedConsumerSignatureRendered: false,
          executedProviderSignatureRendered: true,
        }),
      }),
    }))
  })

  it("does NOT discard the bytes when the commit acknowledgement was merely lost", async () => {
    // Deleting here would leave a countersigned loan bound to an executed
    // agreement whose file no longer exists.
    transactionMock.mockRejectedValue(new Error("connection reset"))
    applicationFindFirstMock.mockResolvedValue({
      agreementCountersignedAt: new Date("2026-07-23T09:00:00.000Z"),
      agreementCountersignedByName: "Jane Provider",
      agreementDocumentSha256: agreementSha256,
      agreementCountersignatureEnvelopeSha256: "f".repeat(64),
    })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("reports reconciliation rather than guessing when the outcome cannot be resolved", async () => {
    transactionMock.mockRejectedValue(new Error("connection reset"))
    applicationFindFirstMock.mockRejectedValue(new Error("database unreachable"))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual(expect.objectContaining({
      countersignEvidence: "commit_outcome_unknown",
    }))
    expect(deleteFileMock).not.toHaveBeenCalled()
  })
})

describe("provider agreement countersign — refusals the UI must be able to show", () => {
  // The Fair Score audit (2026-10-16): the immutability trigger refused the
  // countersignature with 23514, the route answered a bare 500 and the button
  // showed nothing.
  it("answers a database guard refusal with a readable 409, not a 500", async () => {
    const { Prisma } = await import("@prisma/client")
    transactionMock.mockRejectedValue(new Prisma.PrismaClientUnknownRequestError(
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Signed debit-mandate authority is immutable outside an explicit return to review", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
      { clientVersion: "test" },
    ))

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.stringContaining("Signed debit-mandate authority is immutable outside an explicit return to review"),
      countersignEvidence: "database_guard_refused",
    }))
    // Nothing committed, so the staged executed agreement is removed.
    const writtenKey = saveFileMock.mock.calls[0][2] as string
    expect(deleteFileMock).toHaveBeenCalledWith(`/managed/${writtenKey}.pdf`)
  })

  it("still answers an unrelated failure with a 500", async () => {
    transactionMock.mockRejectedValue(new Error("connection reset"))

    await expect(POST(request({ signature: "Jane Provider", attestation: true }), context)).rejects.toThrow("connection reset")
  })

  const branchSignedByCaller = { ...preflight, agreementSignedMethod: "branch", agreementSignedByUserId: "staff-1" }

  it("refuses the witness of the in-branch signature while segregation of duties is on", async () => {
    applicationFindUniqueMock.mockResolvedValue(branchSignedByCaller)

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Segregation of duties: you witnessed the client's in-branch signature, so another staff member must countersign for the lender.",
      segregationOfDuties: "branch_sign_countersign",
    })
    expect(sodRequiredMock).toHaveBeenCalledWith("tenant-1")
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("lets the witness countersign while segregation of duties is off", async () => {
    applicationFindUniqueMock.mockResolvedValue(branchSignedByCaller)
    verifyLockedApprovalMock.mockResolvedValue({
      ok: true,
      application: { ...current, agreementSignedMethod: "branch", agreementSignedByUserId: "staff-1" },
      approval: { calculator: { pricingFingerprint: "pricing-fp" } },
    })
    sodRequiredMock.mockResolvedValue(false)

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).toBe(200)
  })

  it("lets another staff member countersign a branch signature", async () => {
    applicationFindUniqueMock.mockResolvedValue({ ...branchSignedByCaller, agreementSignedByUserId: "staff-2" })

    const response = await POST(request({ signature: "Jane Provider", attestation: true }), context)

    expect(response.status).not.toBe(403)
  })
})
