/**
 * Real-Postgres proof, beside the TypeScript, of migration
 * 20261015090000_identical_id_reupload_not_replacement: a newer, unreviewed ID
 * copy with the current verified copy's digest is no pending replacement.
 *
 * Each case seeds one client (four verified core documents, an in-person
 * attestation over the newest verified ID copy, and the case's ID copies) and
 * asks both layers: subject_has_pending_id_replacement against
 * pendingIdReplacement, and subject_has_composite_kyc against
 * readCompositeKycState. Then the writers: the ClientDocument insert trigger
 * and the upload re-projection leave a VERIFIED client VERIFIED.
 *
 *   RUN_KYC_ID_UPLOAD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/id-identical-reupload.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { pendingIdReplacement } from "@/lib/kyc/id-replacement"
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
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_idsame_${token}`
const reviewerId = `reviewer_idsame_${token}`
const [A, B, C] = ["a", "b", "c"].map((hex) => hex.repeat(64))
const DOB = new Date("1990-04-05T00:00:00.000Z")
const day = (n: number) => new Date(Date.UTC(2026, 6, 1 + n))

/** One ID copy: its digest, whether verified or refused, and its day. */
type Copy = { sha: string | null; verified?: boolean; refused?: boolean; on: number }
let sequence = 0

async function seedClient(copies: Copy[]) {
  sequence += 1
  const clientId = `c_idsame_${sequence}_${token}`
  const subject = { id: clientId, idNumber: `IDSAME-${sequence}-${token}`, firstName: "Synthetic", lastName: "Reupload", dateOfBirth: DOB }
  await db.client.create({ data: {
    ...subject, tenantId, reference: `CLI-IDSAME-${sequence}-${token}`,
    email: `idsame-${sequence}-${token}@test.invalid`, phone: "+27820000066",
  } })
  const idRows = copies.map((copy, index) => ({
    id: `id_${index}_${clientId}`, tenantId, clientId, docType: "ID_COPY" as const, fileUrl: "", fileName: "id.pdf",
    verified: copy.verified ?? false, verifiedAt: copy.verified ? day(copy.on) : null, contentSha256: copy.sha, createdAt: day(copy.on),
    verificationRejectedAt: copy.refused ? day(copy.on) : null, verificationRejectedById: copy.refused ? reviewerId : null,
  }))
  const others = (["PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
    id: `${docType}_${clientId}`, tenantId, clientId, docType, fileUrl: "", fileName: "core.pdf",
    verified: true, verifiedAt: day(0), contentSha256: C, createdAt: day(0),
  }))
  await db.clientDocument.createMany({ data: [...idRows, ...others] })
  // The attestation binds to the copy every reader treats as current.
  const current = idRows.filter((row) => row.verified).sort((x, y) =>
    y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1))[0]
  const completedAt = new Date()
  await db.complianceRecord.create({ data: {
    tenantId, type: "KYC_EXCEPTION", referenceId: clientId, status: "COMPLETED", completedAt,
    data: {
      kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION, clientId,
      idDocumentId: current.id, idDocumentSha256: current.contentSha256, subjectFingerprint: biometricSubjectFingerprint(subject),
      method: "IN_PERSON_BRANCH", note: "Synthetic client attended a branch; face matched the ID photo.",
      approvedAt: completedAt.toISOString(), approvedById: reviewerId,
      approvedByEmail: `reviewer-${token}@test.invalid`, approvedWithTotp: true,
    },
  } })
  return clientId
}

async function verdicts(clientId: string) {
  const [{ pending, composite }] = await db.$queryRawUnsafe<Array<{ pending: boolean; composite: boolean }>>(
    `SELECT "subject_has_pending_id_replacement"("tenantId","id") AS pending,
       "subject_has_composite_kyc"("tenantId","id","idNumber","firstName","lastName","dateOfBirth") AS composite
     FROM "Client" WHERE "id" = $1`,
    clientId,
  )
  const rows = await db.clientDocument.findMany({
    where: { tenantId, clientId, deletedAt: null, docType: "ID_COPY" },
    select: { id: true, docType: true, verified: true, createdAt: true, contentSha256: true, verificationRejectedAt: true, verificationRejectedById: true },
  })
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, { tenantId, clientId, subject: client, existing: client })
  return { sqlPending: pending, tsPending: pendingIdReplacement(rows) !== null, sqlComposite: composite, tsComposite: app.ok }
}

const cases: Array<{ name: string; copies: Copy[]; pending: boolean }> = [
  { name: "control: the verified copy alone", copies: [{ sha: A, verified: true, on: 0 }], pending: false },
  { name: "a newer copy of different bytes", copies: [{ sha: A, verified: true, on: 0 }, { sha: B, on: 1 }], pending: true },
  { name: "a newer copy of the same bytes", copies: [{ sha: A, verified: true, on: 0 }, { sha: A, on: 1 }], pending: false },
  { name: "a newer copy with no digest", copies: [{ sha: A, verified: true, on: 0 }, { sha: null, on: 1 }], pending: true },
  { name: "no digest on either copy", copies: [{ sha: null, verified: true, on: 0 }, { sha: null, on: 1 }], pending: true },
  // A malformed digest cannot be stored (ClientDocument_contentSha256_format_check);
  // the TypeScript case is in id-replacement.test.ts.
  { name: "the same bytes as an older verified copy, not the current one", copies: [{ sha: B, verified: true, on: -1 }, { sha: A, verified: true, on: 0 }, { sha: B, on: 1 }], pending: true },
  { name: "the same bytes newest, over a different unreviewed copy", copies: [{ sha: A, verified: true, on: 0 }, { sha: B, on: 1 }, { sha: A, on: 2 }], pending: false },
  { name: "different bytes newest, over a same-bytes copy", copies: [{ sha: A, verified: true, on: 0 }, { sha: A, on: 1 }, { sha: B, on: 2 }], pending: true },
  { name: "different bytes newest but refused, over a same-bytes copy", copies: [{ sha: A, verified: true, on: 0 }, { sha: A, on: 1 }, { sha: B, refused: true, on: 2 }], pending: false },
]

suite("identical ID re-upload: TypeScript and SQL agree", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `idsame-${token}`, name: "Identical re-upload" } })
    await db.user.create({ data: {
      id: reviewerId, tenantId, email: `reviewer-${token}@test.invalid`, password: "synthetic",
      role: "ADMIN", active: true, totpEnabled: true, lastTotpCounter: 1,
    } })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const result = await verdicts(await seedClient(c.copies))
    // Composite KYC holds only when no replacement is pending and the
    // attested copy carries a usable digest.
    const composite = !c.pending && /^[a-f0-9]{64}$/.test(c.copies.find((copy) => copy.verified && copy.on === 0)?.sha ?? "")
    expect(result).toEqual({ sqlPending: c.pending, tsPending: c.pending, sqlComposite: composite, tsComposite: composite })
  })

  async function verifiedClient() {
    const clientId = await seedClient([{ sha: A, verified: true, on: 0 }])
    await db.client.update({ where: { id: clientId }, data: {
      kycStatus: "VERIFIED", kycVerifiedAt: new Date(), kycVerifiedById: reviewerId, kycVerificationMethod: "PHYSICAL",
    } })
    return clientId
  }
  const newCopy = (clientId: string, id: string, sha: string) => ({
    id, tenantId, clientId, docType: "ID_COPY" as const, fileUrl: "", fileName: "id.pdf", verified: false, contentSha256: sha,
  })

  it("leaves a VERIFIED client VERIFIED when the same bytes are inserted, and demotes on other bytes", async () => {
    const clientId = await verifiedClient()
    await db.clientDocument.create({ data: newCopy(clientId, `same_${clientId}`, A) })
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).kycStatus).toBe("VERIFIED")
    expect(await db.auditLog.count({ where: { tenantId, entityId: clientId, userEmail: "database@composite-kyc-guard" } })).toBe(0)

    await db.clientDocument.create({ data: newCopy(clientId, `other_${clientId}`, B) })
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).kycStatus).toBe("PENDING")
  })

  it("re-projects nothing when the upload is the same bytes", async () => {
    const clientId = await verifiedClient()
    const result = await db.$transaction(async (tx) => {
      const kycTx = tx as unknown as IdUploadProjectionTransaction
      const before = await readKycBeforeIdUpload(kycTx, { tenantId, clientId })
      await tx.clientDocument.create({ data: newCopy(clientId, `upload_${clientId}`, A) })
      return reprojectKycAfterIdUpload(kycTx, {
        tenantId, clientId, documentId: `upload_${clientId}`, before, actor: { type: "staff", userId: reviewerId },
      })
    })
    expect(result).toEqual({ changed: false })
    expect((await db.client.findUniqueOrThrow({ where: { id: clientId } })).kycStatus).toBe("VERIFIED")
  })
})
