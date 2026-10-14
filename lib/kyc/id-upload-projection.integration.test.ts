/**
 * Real-Postgres proof that uploading a replacement ID copy re-projects the
 * stored Client KYC status.
 *
 * The database does NOT do this itself: client_has_composite_kyc keeps the
 * older verified copy, so inserting the new ID_COPY row leaves the cached
 * VERIFIED in place. Only reprojectKycAfterIdUpload demotes it.
 *
 *   RUN_KYC_ID_UPLOAD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/id-upload-projection.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import {
  reprojectKycAfterIdUpload,
  type IdUploadProjectionTransaction,
} from "@/lib/kyc/id-upload-projection.server"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const RUN = process.env.RUN_KYC_ID_UPLOAD_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()

const token = randomUUID().replaceAll("-", "")
const tenantId = `t_${token}`
const clientId = `c_${token}`
const reviewerId = `reviewer_${token}`
const idNumber = `8905${token.replace(/\D/g, "").padEnd(9, "0").slice(0, 9)}`
const OLD_ID_SHA = "a".repeat(64)
const NEW_ID_SHA = "f".repeat(64)

async function uploadNewIdCopy(documentId: string, rejectedBy: string | null) {
  return db.$transaction(async (tx) => {
    await tx.clientDocument.create({
      data: {
        id: documentId, clientId, tenantId, docType: "ID_COPY", fileUrl: "/f",
        fileName: "id-new.pdf", verified: false, contentSha256: NEW_ID_SHA,
        verificationRejectedById: rejectedBy,
        verificationRejectedAt: rejectedBy ? new Date() : null,
        verificationNote: rejectedBy ? "Unreadable" : null,
      },
    })
    return reprojectKycAfterIdUpload(tx as unknown as IdUploadProjectionTransaction, {
      tenantId,
      clientId,
      documentId,
      actor: { type: "staff", userId: reviewerId },
    })
  })
}

const storedStatus = async () =>
  (await db.client.findUniqueOrThrow({ where: { id: clientId } })).kycStatus

suite("ID upload KYC re-projection against the database", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `idup-${token}`, name: "ID upload probe" } })
    await db.user.create({ data: {
      id: reviewerId, tenantId, email: `reviewer-${token}@test.invalid`, password: "synthetic",
      role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1,
    } })
    await db.client.create({
      data: {
        id: clientId, tenantId, reference: `CL-${token}`, idNumber,
        firstName: "Dineo", lastName: "Testperson", email: `${token}@example.com`,
        phone: "0600000000", dateOfBirth: new Date("1989-05-31T00:00:00.000Z"),
        kycStatus: "PENDING",
      },
    })
    await db.clientDocument.createMany({
      data: [
        { id: `d_id_${token}`, clientId, tenantId, docType: "ID_COPY", fileUrl: "/f", fileName: "id.pdf", verified: true, contentSha256: OLD_ID_SHA, createdAt: new Date("2026-07-01T00:00:00.000Z") },
        { id: `d_poa_${token}`, clientId, tenantId, docType: "PROOF_OF_ADDRESS", fileUrl: "/f", fileName: "poa.pdf", verified: true, contentSha256: "b".repeat(64) },
        { id: `d_pay_${token}`, clientId, tenantId, docType: "PAYSLIP", fileUrl: "/f", fileName: "pay.pdf", verified: true, contentSha256: "c".repeat(64) },
        { id: `d_bank_${token}`, clientId, tenantId, docType: "BANK_STATEMENT", fileUrl: "/f", fileName: "bank.pdf", verified: true, contentSha256: "d".repeat(64) },
      ],
    })
    const [{ fingerprint }] = await db.$queryRawUnsafe<{ fingerprint: string }[]>(
      `SELECT "biometric_subject_fingerprint"($1,$2,$3,$4,$5::timestamp(3)) AS fingerprint`,
      clientId, idNumber, "Dineo", "Testperson", new Date("1989-05-31T00:00:00.000Z"),
    )
    const completedAt = new Date()
    await db.complianceRecord.create({
      data: {
        id: `cr_${token}`, tenantId, type: "KYC_EXCEPTION", referenceId: clientId,
        status: "COMPLETED", completedAt,
        data: {
          kind: IN_PERSON_KYC_VERIFICATION_KIND,
          version: IN_PERSON_KYC_VERIFICATION_VERSION,
          clientId,
          idDocumentId: `d_id_${token}`,
          idDocumentSha256: OLD_ID_SHA,
          subjectFingerprint: fingerprint,
          method: "IN_PERSON_BRANCH",
          note: "Client attended branch; face matched the ID photo.",
          approvedAt: completedAt.toISOString(),
          approvedById: reviewerId,
          approvedByEmail: `reviewer-${token}@test.invalid`,
          approvedWithTotp: true,
        },
      },
    })
    // The database accepts VERIFIED only because the evidence holds.
    await db.client.update({
      where: { id: clientId },
      data: {
        kycStatus: "VERIFIED", kycVerifiedAt: completedAt,
        kycVerifiedById: reviewerId, kycVerificationMethod: "PHYSICAL",
      },
    })
  })

  afterAll(async () => {
    try {
      await db.clientDocument.deleteMany({ where: { tenantId } })
      await db.client.deleteMany({ where: { tenantId } })
      await db.tenant.deleteMany({ where: { id: tenantId } })
    } catch {
      // Immutable compliance evidence keeps its FKs alive on a throwaway DB.
    }
    await db.$disconnect()
  })

  it("leaves a newer refused ID copy's client VERIFIED and writes nothing", async () => {
    const result = await uploadNewIdCopy(`d_id_refused_${token}`, reviewerId)

    expect(result).toEqual({ changed: false })
    expect(await storedStatus()).toBe("VERIFIED")
    await db.clientDocument.delete({ where: { id: `d_id_refused_${token}` } })
  })

  it("demotes a VERIFIED client to PENDING when a newer unreviewed ID copy arrives, with an audit row", async () => {
    // The row alone does not move the status: the database keeps the old copy.
    await db.clientDocument.create({
      data: {
        id: `d_id_probe_${token}`, clientId, tenantId, docType: "ID_COPY", fileUrl: "/f",
        fileName: "probe.pdf", verified: false, contentSha256: NEW_ID_SHA,
      },
    })
    expect(await storedStatus()).toBe("VERIFIED")
    await db.clientDocument.delete({ where: { id: `d_id_probe_${token}` } })

    const result = await uploadNewIdCopy(`d_id_new_${token}`, null)

    expect(result).toEqual({ changed: true })
    const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
    expect(client).toMatchObject({
      kycStatus: "PENDING",
      kycVerifiedAt: null,
      kycVerifiedById: null,
      kycVerificationMethod: null,
    })
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: clientId, action: "KYC_STATUS_CHANGED", userId: reviewerId },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0].newValue).toMatchObject({
      reason: "id_document_uploaded",
      documentId: `d_id_new_${token}`,
      coreDocumentGaps: [{ docType: "ID_COPY", state: "awaiting_verification" }],
    })
  })
})
