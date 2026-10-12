/**
 * Real-Postgres proof that the bank-extraction route observes the database
 * trigger's VERIFIED -> PENDING revocation before projecting/auditing FAILED.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run 'app/api/clients/[id]/apply-extraction/route.integration.test.ts'
 */
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"

const testState = vi.hoisted(() => ({
  tenantId: "",
  userId: "",
  userEmail: "",
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockImplementation(async () => ({
    error: null,
    user: {
      id: testState.userId,
      email: testState.userEmail,
      role: "CREDIT_OFFICER",
    },
  })),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: NextRequest,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: testState.tenantId }),
}))

import { POST } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("bank extraction KYC projection with database evidence trigger", () => {
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "")
  const ids = {
    tenant: `tenant_bank_extract_${token}`,
    user: `user_bank_extract_${token}`,
    client: `client_bank_extract_${token}`,
    bankDocument: `bank_document_extract_${token}`,
    selfie: `selfie_bank_extract_${token}`,
  }
  const subject = {
    id: ids.client,
    idNumber: `BANK-EXTRACT-${token}`,
    firstName: "Synthetic",
    lastName: "Bank Extraction",
    dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
  }

  beforeAll(async () => {
    testState.tenantId = ids.tenant
    testState.userId = ids.user
    testState.userEmail = `officer-bank-extract-${token}@test.invalid`

    await db.tenant.create({
      data: {
        id: ids.tenant,
        slug: `bank-extract-${token}`,
        name: "Bank Extraction Trigger Integration",
      },
    })
    await db.user.create({
      data: {
        id: ids.user,
        tenantId: ids.tenant,
        email: testState.userEmail,
        name: "Synthetic Credit Officer",
        password: "not-a-login-credential",
        role: "CREDIT_OFFICER",
      },
    })
    await db.client.create({
      data: {
        ...subject,
        tenantId: ids.tenant,
        reference: `CLI-BANK-EXTRACT-${token}`,
        email: `client-bank-extract-${token}@test.invalid`,
        phone: "+27820000031",
        bankName: "ABSA",
        bankAccountNumber: "40987654321",
        bankBranchCode: "632005",
        // No accountType: extraction may only set it on a record that has none
        // (staff-confirmed wins — lib/kyc/extraction-bank-fields.ts).
      },
    })

    const verifiedAt = new Date("2026-07-23T02:00:00.000Z")
    await db.clientDocument.createMany({
      data: [
        {
          id: `id_bank_extract_${token}`,
          tenantId: ids.tenant,
          clientId: ids.client,
          docType: "ID_COPY",
          fileUrl: "",
          fileName: "id.pdf",
          verified: true,
          verifiedAt,
        },
        {
          id: `address_bank_extract_${token}`,
          tenantId: ids.tenant,
          clientId: ids.client,
          docType: "PROOF_OF_ADDRESS",
          fileUrl: "",
          fileName: "address.pdf",
          verified: true,
          verifiedAt,
        },
        {
          id: `payslip_bank_extract_${token}`,
          tenantId: ids.tenant,
          clientId: ids.client,
          docType: "PAYSLIP",
          fileUrl: "",
          fileName: "payslip.pdf",
          verified: true,
          verifiedAt,
        },
        {
          id: ids.bankDocument,
          tenantId: ids.tenant,
          clientId: ids.client,
          docType: "BANK_STATEMENT",
          fileUrl: "",
          fileName: "bank.pdf",
          verified: true,
          verifiedAt,
          createdAt: new Date("2026-07-23T01:00:00.000Z"),
          extractionStatus: "done",
          extractionGeneration: `generation-${token}`,
          extractionResult: {
            bankName: { value: "FNB" },
            accountNumber: { value: "62000000000" },
            branchCode: { value: "250655" },
            accountType: { value: "CHEQUE" },
          },
          validationResult: {
            isValid: true,
            matchScore: 100,
            mismatches: [],
          },
          validationScore: 100,
        },
      ],
    })
    // A newer statement a named reviewer refused, while the older one above
    // still carries BANK_STATEMENT. Once the apply invalidates the verified
    // statement, this refusal is the CURRENT bank document, so the composite
    // roll-up is FAILED — the projection the route must audit from the
    // trigger's durable PENDING. Without it the composite is PENDING too: a
    // system re-flag after a bank-detail change is not an adverse finding
    // (lib/kyc/document-state.ts), and the route has nothing to project.
    await db.clientDocument.create({
      data: {
        id: `bank_refused_extract_${token}`,
        tenantId: ids.tenant,
        clientId: ids.client,
        docType: "BANK_STATEMENT",
        fileUrl: "",
        fileName: "bank-reupload.pdf",
        verified: false,
        verificationNote: "Synthetic refusal: statement is illegible.",
        verificationRejectedAt: new Date("2026-07-23T03:00:00.000Z"),
        verificationRejectedById: ids.user,
        createdAt: new Date("2026-07-23T03:00:00.000Z"),
      },
    })
    await db.clientDocument.create({
      data: {
        id: ids.selfie,
        tenantId: ids.tenant,
        clientId: ids.client,
        docType: "SELFIE",
        fileUrl: "",
        fileName: "selfie.jpg",
        verified: true,
        verifiedAt,
        extractionStatus: "done",
        extractionResult: {
          faceDetected: { value: true },
          facesCount: { value: 1 },
          isLive: { value: true },
          quality: { value: "good" },
        },
        validationMismatch: false,
        validationScore: 98,
        biometricMatchScore: 98,
        biometricLiveness: 97,
        biometricVerifiedAt: verifiedAt,
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
          subjectFingerprint: biometricSubjectFingerprint(subject),
        },
      },
    })
    await db.client.update({
      where: { id: ids.client },
      data: {
        kycStatus: "VERIFIED",
        kycVerifiedAt: verifiedAt,
        kycVerificationMethod: "SMILE_IDENTITY",
      },
    })
  })

  it("audits the durable PENDING predecessor before the route projects FAILED", async () => {
    const response = await POST(
      new NextRequest(
        `http://localhost/api/clients/${ids.client}/apply-extraction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ documentId: ids.bankDocument }),
        },
      ),
      { params: Promise.resolve({ id: ids.client }) },
    )

    expect(response.status).toBe(200)
    await expect(db.client.findUniqueOrThrow({
      where: { id: ids.client },
      select: {
        bankName: true,
        bankAccountNumber: true,
        bankBranchCode: true,
        accountType: true,
        kycStatus: true,
      },
    })).resolves.toEqual({
      bankName: "FNB",
      bankAccountNumber: "62000000000",
      bankBranchCode: "250655",
      accountType: "CHEQUE",
      kycStatus: "FAILED",
    })
    await expect(db.clientDocument.findUniqueOrThrow({
      where: { id: ids.bankDocument },
      select: { verified: true, verificationNote: true },
    })).resolves.toEqual({
      verified: false,
      verificationNote:
        "Bank details were applied from extraction; verify against the current client account before disbursement.",
    })

    const appProjectionAudit = await db.auditLog.findFirstOrThrow({
      where: {
        tenantId: ids.tenant,
        entityId: ids.client,
        action: "KYC_STATUS_CHANGED",
        userId: ids.user,
      },
      orderBy: { createdAt: "desc" },
    })
    expect(appProjectionAudit.oldValue).toEqual(expect.objectContaining({
      reason: "bank_evidence_invalidated",
      clientKyc: expect.objectContaining({ kycStatus: "PENDING" }),
    }))
    expect(appProjectionAudit.newValue).toEqual(expect.objectContaining({
      reason: "bank_evidence_invalidated",
      clientKyc: expect.objectContaining({ kycStatus: "FAILED" }),
    }))

    await expect(db.auditLog.count({
      where: {
        tenantId: ids.tenant,
        entityId: ids.client,
        userEmail: "database@composite-kyc-guard",
        action: "KYC_STATUS_CHANGED",
      },
    })).resolves.toBe(1)
  })
})
