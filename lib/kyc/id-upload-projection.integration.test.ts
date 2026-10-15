/**
 * Real-Postgres proof of the replacement-ID rule and the upload re-projection.
 *
 * Migration 20261014130000_replacement_id_pending_not_verified makes
 * subject_has_composite_kyc refuse a client whose newest, non-refused ID copy
 * is unverified while an older one is verified. That one function feeds the
 * Client trigger (VERIFIED writes) and the ClientDocument revoke trigger, so
 * inserting the replacement demotes a VERIFIED client by itself.
 * reprojectKycAfterIdUpload covers what the database does not: the stored
 * status when it is not VERIFIED (FAILED -> PENDING).
 *
 *   RUN_KYC_ID_UPLOAD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/id-upload-projection.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import {
  readKycBeforeIdUpload,
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
const failedClientId = `cf_${token}`
const reviewerId = `reviewer_${token}`
const idNumber = (seed: string) => `8905${(seed + token).replace(/\D/g, "").padEnd(9, "0").slice(0, 9)}`
const OLD_ID_SHA = "a".repeat(64)
const NEW_ID_SHA = "f".repeat(64)
const DOB = new Date("1989-05-31T00:00:00.000Z")

const idCopyRow = (
  id: string,
  forClient: string,
  extra: { verified: boolean; createdAt?: Date; refusedBy?: string; sha?: string },
) => ({
  id, clientId: forClient, tenantId, docType: "ID_COPY" as const, fileUrl: "/f", fileName: "id.pdf",
  verified: extra.verified, contentSha256: extra.sha ?? OLD_ID_SHA,
  createdAt: extra.createdAt,
  verificationRejectedById: extra.refusedBy ?? null,
  verificationRejectedAt: extra.refusedBy ? new Date() : null,
  verificationNote: extra.refusedBy ? "Unreadable" : null,
})

function otherCoreRows(forClient: string, prefix: string) {
  return [
    { id: `${prefix}_poa_${token}`, docType: "PROOF_OF_ADDRESS" as const, sha: "b" },
    { id: `${prefix}_pay_${token}`, docType: "PAYSLIP" as const, sha: "c" },
    { id: `${prefix}_bank_${token}`, docType: "BANK_STATEMENT" as const, sha: "d" },
  ].map(({ id, docType, sha }) => ({
    id, clientId: forClient, tenantId, docType, fileUrl: "/f", fileName: `${id}.pdf`,
    verified: true, contentSha256: sha.repeat(64),
  }))
}

async function uploadNewIdCopy(forClient: string, documentId: string) {
  return db.$transaction(async (tx) => {
    const kycTx = tx as unknown as IdUploadProjectionTransaction
    const before = await readKycBeforeIdUpload(kycTx, { tenantId, clientId: forClient })
    await tx.clientDocument.create({ data: idCopyRow(documentId, forClient, { verified: false, sha: NEW_ID_SHA }) })
    return reprojectKycAfterIdUpload(kycTx, {
      tenantId,
      clientId: forClient,
      documentId,
      before,
      actor: { type: "staff", userId: reviewerId },
    })
  })
}

const stored = (forClient: string) => db.client.findUniqueOrThrow({ where: { id: forClient } })

/** Raised by Client_enforce_composite_kyc when the evidence does not hold. */
async function verifiedWriteAccepted(forClient: string): Promise<boolean> {
  try {
    await db.client.update({ where: { id: forClient }, data: { kycStatus: "VERIFIED" } })
    return true
  } catch {
    return false
  }
}

async function inPersonAttestation() {
  const [{ fingerprint }] = await db.$queryRawUnsafe<{ fingerprint: string }[]>(
    `SELECT "biometric_subject_fingerprint"($1,$2,$3,$4,$5::timestamp(3)) AS fingerprint`,
    clientId, idNumber("1"), "Dineo", "Testperson", DOB,
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
  return completedAt
}

suite("replacement ID copy against the database", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `idup-${token}`, name: "ID upload probe" } })
    await db.user.create({ data: {
      id: reviewerId, tenantId, email: `reviewer-${token}@test.invalid`, password: "synthetic",
      role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1,
    } })
    for (const [id, seed, status] of [[clientId, "1", "PENDING"], [failedClientId, "2", "FAILED"]] as const) {
      await db.client.create({
        data: {
          id, tenantId, reference: `CL-${id}`, idNumber: idNumber(seed),
          firstName: "Dineo", lastName: "Testperson", email: `${id}@example.com`,
          phone: "0600000000", dateOfBirth: DOB, kycStatus: status,
        },
      })
    }
    await db.clientDocument.createMany({
      data: [
        idCopyRow(`d_id_${token}`, clientId, { verified: true, createdAt: new Date("2026-07-01T00:00:00.000Z") }),
        ...otherCoreRows(clientId, "v"),
        // The FAILED client's only ID copy was refused by a reviewer.
        idCopyRow(`f_id_${token}`, failedClientId, { verified: false, refusedBy: reviewerId, createdAt: new Date("2026-07-01T00:00:00.000Z") }),
        ...otherCoreRows(failedClientId, "f"),
      ],
    })
    const completedAt = await inPersonAttestation()
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

  it("keeps a client VERIFIED when the newer ID copy was refused by a reviewer", async () => {
    await db.clientDocument.create({ data: idCopyRow(`d_id_refused_${token}`, clientId, { verified: false, refusedBy: reviewerId, sha: NEW_ID_SHA }) })

    expect((await stored(clientId)).kycStatus).toBe("VERIFIED")
    await db.clientDocument.delete({ where: { id: `d_id_refused_${token}` } })
  })

  it("keeps a client VERIFIED when the newer copy carries only a rejection timestamp", async () => {
    await db.clientDocument.create({ data: {
      ...idCopyRow(`d_id_stamped_${token}`, clientId, { verified: false, sha: NEW_ID_SHA }),
      verificationRejectedAt: new Date(),
    } })

    expect((await stored(clientId)).kycStatus).toBe("VERIFIED")
    await db.clientDocument.delete({ where: { id: `d_id_stamped_${token}` } })
  })

  it("demotes a VERIFIED client the moment an unreviewed newer ID copy is inserted, with the trigger's audit row", async () => {
    await db.clientDocument.create({ data: idCopyRow(`d_id_probe_${token}`, clientId, { verified: false, sha: NEW_ID_SHA }) })

    expect(await stored(clientId)).toMatchObject({
      kycStatus: "PENDING", kycVerifiedAt: null, kycVerifiedById: null, kycVerificationMethod: null,
    })
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: clientId, action: "KYC_STATUS_CHANGED", userEmail: "database@composite-kyc-guard" },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0].newValue).toMatchObject({ reason: "composite_kyc_evidence_changed", documentType: "ID_COPY" })
  })

  it("refuses to write VERIFIED while the replacement awaits review, whatever the writer", async () => {
    // d_id_probe is still on file from the previous case.
    expect(await verifiedWriteAccepted(clientId)).toBe(false)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
  })

  it("accepts VERIFIED again once a reviewer refuses the replacement", async () => {
    await db.clientDocument.update({
      where: { id: `d_id_probe_${token}` },
      data: { verificationRejectedById: reviewerId, verificationRejectedAt: new Date(), verificationNote: "Unreadable" },
    })

    expect(await verifiedWriteAccepted(clientId)).toBe(true)
    await db.clientDocument.delete({ where: { id: `d_id_probe_${token}` } })
  })

  it("accepts VERIFIED again once the pending replacement is removed", async () => {
    await db.clientDocument.create({ data: idCopyRow(`d_id_new_${token}`, clientId, { verified: false, sha: NEW_ID_SHA }) })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect(await verifiedWriteAccepted(clientId)).toBe(false)

    await db.clientDocument.update({ where: { id: `d_id_new_${token}` }, data: { deletedAt: new Date() } })

    expect(await verifiedWriteAccepted(clientId)).toBe(true)
  })

  it("moves a FAILED client to PENDING, audited, when a new ID replaces the refused one", async () => {
    const result = await uploadNewIdCopy(failedClientId, `f_id_new_${token}`)

    expect(result).toEqual({ changed: true })
    expect((await stored(failedClientId)).kycStatus).toBe("PENDING")
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: failedClientId, action: "KYC_STATUS_CHANGED", userId: reviewerId },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0].newValue).toMatchObject({
      reason: "id_document_uploaded",
      documentId: `f_id_new_${token}`,
    })
  })

  it("attributes to the actor a demotion the insert's database trigger made on its own", async () => {
    // "accepts VERIFIED again once the pending replacement is removed" left the
    // client VERIFIED on the original copy; the FAILED-client case in between
    // uses a different client.
    expect((await stored(clientId)).kycStatus).toBe("VERIFIED")
    const result = await uploadNewIdCopy(clientId, `d_id_second_${token}`)

    expect(result).toEqual({ changed: true })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    // The trigger's own row has no actor; the upload adds the attributed one.
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityId: clientId, action: "KYC_STATUS_CHANGED", userId: reviewerId },
    })
    expect(audit).toHaveLength(1)
    expect(audit[0].oldValue).toMatchObject({ clientKyc: { kycStatus: "VERIFIED" } })
    expect(audit[0].newValue).toMatchObject({
      reason: "id_document_uploaded",
      documentId: `d_id_second_${token}`,
      demotedByDatabase: true,
      clientKyc: { kycStatus: "PENDING" },
    })
  })

  it("writes no attributed audit row when the upload changed nothing", async () => {
    const before = await db.auditLog.count({ where: { tenantId, entityId: clientId, userId: reviewerId } })
    const result = await uploadNewIdCopy(clientId, `d_id_third_${token}`)

    expect(result).toEqual({ changed: false })
    expect(await db.auditLog.count({ where: { tenantId, entityId: clientId, userId: reviewerId } })).toBe(before)
  })
})
