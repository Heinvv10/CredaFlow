/**
 * End-to-end proof, on a real migrated PostgreSQL, that the face-match gates
 * hold through the real pipeline: captureSelfie -> runBiometricVerification ->
 * persistBiometricOutcome, the in-person and senior-exception routes, and the
 * Client composite-KYC trigger. Only the VLM HTTP call (fetch), the face
 * model's comparison (compareFaces: the stored "ID bytes" here are not an
 * image), file storage and session/tenant resolution are stubbed. The stubbed
 * comparison's evidence is still re-proved by both real gates.
 *
 * Supersedes face-match-v2-pipeline.integration.test.ts: after migration
 * 20261011080000_face_match_v3_evidence a v2 pass no longer verifies anyone,
 * so every case it held runs here through the v3 pipeline, plus the face
 * model's refusals.
 *
 *   RUN_FACE_MATCH_V3_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v3-pipeline.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"

const ctx = vi.hoisted(() => ({
  tenantId: "", adminId: "", readPaths: [] as string[],
  comparison: null as unknown,
}))
vi.mock("@/lib/kyc/face-model/compare.server", async () => {
  const { PASSING_FACE_MODEL_EVIDENCE } = await import("@/lib/kyc/face-model/evidence.test-helpers")
  return {
    compareFaces: vi.fn(async () => ctx.comparison ?? { ok: true, evidence: PASSING_FACE_MODEL_EVIDENCE, rejection: null }),
  }
})
vi.mock("@/lib/storage", () => ({
  readFile: vi.fn(async (storagePath: string) => {
    ctx.readPaths.push(storagePath)
    return Buffer.from("id-image-bytes")
  }),
  saveFile: vi.fn(async () => ({ storagePath: `stub/selfie-${Math.random()}`, fileSize: 12 })),
  deleteFile: vi.fn(async () => undefined),
}))
// lib/document-auth (the selfie magic-byte check) imports the NextAuth config.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.adminId, email: `${ctx.adminId}@test.invalid`, role: "ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
      runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
  }
})

import { runWithTenant } from "@/lib/tenant-scope"
import { captureSelfie } from "@/lib/kyc/selfie-capture.server"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"
import { POST as exceptionPOST } from "@/app/api/clients/[id]/kyc-exception/route"
import { POST as inPersonPOST } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import { PATCH as verifyPATCH } from "@/app/api/clients/[id]/documents/[docId]/verify/route"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"

const RUN = process.env.RUN_FACE_MATCH_V3_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const ID_SHA = "a".repeat(64)
let sequence = 0

const passingReply = (change: Record<string, unknown> = {}) => ({
  faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
  selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true, samePerson: "same", faceMatch: true, matchConfidence: 0.93, ...change,
})

function stubVlm(reply: Record<string, unknown>) {
  vi.stubEnv("VLM_API_URL", "http://vlm.stub.invalid")
  vi.stubEnv("VLM_MODEL", "stub-model")
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(reply) } }],
  }), { status: 200 })))
}

/** A PENDING client with four verified core documents; the ID copy is hashed. */
async function seedClient() {
  sequence += 1
  const tenantId = `t_fm_pipe_${sequence}_${token}`
  const clientId = `c_fm_pipe_${sequence}_${token}`
  const idCopyId = `fm_pipe_ID_COPY_${sequence}_${token}`
  await db.tenant.create({ data: { id: tenantId, slug: `fm-pipe-${sequence}-${token}`, name: "Pipeline" } })
  await db.client.create({
    data: {
      id: clientId, tenantId, reference: `CLI-FMPIPE-${sequence}-${token}`,
      idNumber: `FMPIPE-${sequence}-${token}`, firstName: "Synthetic", lastName: "Pipeline",
      email: `fm-pipe-${sequence}-${token}@test.invalid`, phone: "+27820000066",
    },
  })
  const createdAt = new Date(Date.now() - 60_000)
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
      id: `fm_pipe_${docType}_${sequence}_${token}`, tenantId, clientId, docType, fileUrl: "",
      fileName: "core.jpg", mimeType: "image/jpeg", storagePath: `stub/${docType}-${sequence}`,
      contentSha256: ID_SHA, verified: true, verifiedAt: createdAt, createdAt,
    })),
  })
  // The routes audit as this user, and AuditLog.userId is a foreign key.
  const admin = await db.user.create({
    data: { email: `fm-pipe-admin-${sequence}-${token}@test.invalid`, password: "x", role: "ADMIN", tenantId },
  })
  ctx.tenantId = tenantId
  ctx.adminId = admin.id
  return { tenantId, clientId, idCopyId }
}

/** Another ID copy for the client, newer than the seeded one. */
async function addIdCopy(
  fixture: { tenantId: string; clientId: string },
  label: string,
  fields: { verified: boolean; contentSha256: string; rejected?: boolean },
) {
  const id = `fm_pipe_ID_${label}_${sequence}_${token}`
  await db.clientDocument.create({
    data: {
      id, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "ID_COPY", fileUrl: "",
      fileName: `${label}.jpg`, mimeType: "image/jpeg", storagePath: `stub/${label}-${sequence}`,
      contentSha256: fields.contentSha256, uploadedByType: "client", verified: fields.verified,
      verifiedAt: fields.verified ? new Date() : null,
      ...(fields.rejected
        ? {
            verificationNote: "Rejected: the photo does not match the ID on file",
            verificationRejectedAt: new Date(),
            verificationRejectedById: "officer-synthetic",
          }
        : {}),
    },
  })
  return id
}

const jpeg = () => new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])], "selfie.jpg", {
  type: "image/jpeg",
})

/** Capture through the real entry point and wait for the async face match. */
async function capture(fixture: { tenantId: string; clientId: string }) {
  const result = await runWithTenant(fixture.tenantId, () => captureSelfie({
    tenantId: fixture.tenantId,
    clientId: fixture.clientId,
    image: jpeg(),
    uploader: { type: "client", clientId: fixture.clientId, email: null },
  }))
  if (!result.ok) return { result, selfie: null }
  await vi.waitFor(async () => {
    const row = await db.clientDocument.findUniqueOrThrow({ where: { id: result.documentId } })
    expect(row.extractionStatus).not.toBe("processing")
  }, { timeout: 10_000, interval: 50 })
  const selfie = await db.clientDocument.findUniqueOrThrow({
    where: { id: result.documentId },
    select: { extractionStatus: true, verified: true, biometricResult: true },
  })
  return { result, selfie }
}

/** Run the pipeline directly against a chosen ID copy, as a stale callback would. */
async function attemptAgainst(fixture: { tenantId: string; clientId: string }, idDocumentId: string) {
  const idDocument = await db.clientDocument.findUniqueOrThrow({
    where: { id: idDocumentId },
    select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
  })
  const selfieId = `fm_pipe_selfie_${sequence}_${randomUUID().slice(0, 8)}`
  const generation = randomUUID()
  await db.clientDocument.create({
    data: {
      id: selfieId, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "SELFIE",
      fileUrl: "", fileName: "selfie.jpg", mimeType: "image/jpeg", storagePath: "stub/selfie",
      contentSha256: "e".repeat(64), uploadedByType: "client", extractionStatus: "processing",
      extractionGeneration: generation, extractionStartedAt: new Date(),
    },
  })
  await runWithTenant(fixture.tenantId, () => runBiometricVerification(
    selfieId, fixture.clientId, fixture.tenantId, generation, Buffer.from("selfie-bytes"), "image/jpeg", idDocument,
  ))
  return db.clientDocument.findUniqueOrThrow({
    where: { id: selfieId },
    select: { extractionStatus: true, verified: true, biometricResult: true },
  })
}

const reasonOf = (selfie: { biometricResult: unknown } | null) =>
  (selfie?.biometricResult as Record<string, unknown> | null)?.biometricFailureReason

const kyc = (clientId: string) => db.client.findUniqueOrThrow({
  where: { id: clientId },
  select: { kycStatus: true, kycVerificationMethod: true },
})

const recordInPerson = (clientId: string) => inPersonPOST(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({ method: "IN_PERSON_BRANCH", note: "Synthetic applicant attended a branch and matched the ID photo." }),
}) as never, { params: Promise.resolve({ id: clientId }) })

const verifyDocument = (clientId: string, docId: string) => verifyPATCH(new NextRequest(
  "http://localhost/",
  { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ verified: true }) },
), { params: Promise.resolve({ id: clientId, docId }) })

/** The composite verdict of the app (readCompositeKycState) and of the database. */
async function layers(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId: client.tenantId, clientId, subject: client, existing: client,
  })
  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "client_has_composite_kyc"($1, $2) AS ok`, client.tenantId, clientId,
  )
  return { app: app.ok, appReason: app.biometricEvidence, sql: ok }
}

const recordException = (clientId: string) => exceptionPOST(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({
    reason: "Synthetic senior exception after a failed selfie capture.",
    supportingEvidence: "Synthetic review of four verified core documents.",
  }),
}) as never, { params: Promise.resolve({ id: clientId }) })

suite("face match v3 through the real pipeline", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    ctx.readPaths = []
    ctx.comparison = null
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  describe("an ID copy refused as having no real photograph", () => {
    const silhouette = passingReply({
      idPhotoKind: "silhouette_placeholder", idPhotoIsRealPhotograph: false, idPhotoFaceDetected: false,
    })

    it("closes the in-person route over that ID copy", async () => {
      const fixture = await seedClient()
      stubVlm(silhouette)
      const { selfie } = await capture(fixture)
      expect(reasonOf(selfie)).toBe("id_document_portrait_invalid")

      const response = await recordInPerson(fixture.clientId)
      expect(response.status).toBe(422)
      expect((await response.json()).error).toMatch(/no real photograph/)
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
    })

    it("refuses VERIFIED in the database on an attestation bound to that ID copy", async () => {
      const fixture = await seedClient()
      stubVlm(silhouette)
      await capture(fixture)
      const client = await db.client.findUniqueOrThrow({ where: { id: fixture.clientId } })
      const [{ fingerprint }] = await db.$queryRawUnsafe<Array<{ fingerprint: string }>>(
        `SELECT "biometric_subject_fingerprint"($1,$2,$3,$4,NULL) AS fingerprint`,
        client.id, client.idNumber, client.firstName, client.lastName,
      )
      const completedAt = new Date("2026-10-12T08:00:00.000Z")
      await db.complianceRecord.create({
        data: {
          tenantId: fixture.tenantId, type: "KYC_EXCEPTION", referenceId: fixture.clientId,
          status: "COMPLETED", completedAt,
          data: {
            kind: "KYC_IN_PERSON_VERIFICATION", version: "kyc-in-person-verification-v1",
            clientId: fixture.clientId, idDocumentId: fixture.idCopyId, idDocumentSha256: ID_SHA,
            subjectFingerprint: fingerprint, method: "IN_PERSON_BRANCH",
            note: "Synthetic attestation written straight to the database.",
            approvedAt: completedAt.toISOString(), approvedById: "admin-synthetic", approvedByEmail: "admin@test.invalid",
          },
        },
      })
      await expect(db.client.update({
        where: { id: fixture.clientId },
        data: { kycStatus: "VERIFIED", kycVerifiedAt: new Date(), kycVerifiedById: "admin-synthetic", kycVerificationMethod: "PHYSICAL" },
      })).rejects.toThrow("Client KYC cannot be VERIFIED without current composite evidence")
    })

    it("re-opens the in-person route once a newer ID copy is verified", async () => {
      const fixture = await seedClient()
      stubVlm(silhouette)
      await capture(fixture)
      await addIdCopy(fixture, "replacement", { verified: true, contentSha256: "b".repeat(64) })

      const response = await recordInPerson(fixture.clientId)
      expect(response.status).toBe(200)
      expect(await kyc(fixture.clientId)).toEqual({ kycStatus: "VERIFIED", kycVerificationMethod: "PHYSICAL" })
    })

    it("leaves the in-person route open after a selfie refused as not a real photograph", async () => {
      // Physical presence answers a fake selfie; it cannot answer an ID with no photo.
      const fixture = await seedClient()
      stubVlm(passingReply({ selfieIsRealPhotograph: false }))
      const { selfie } = await capture(fixture)
      expect(reasonOf(selfie)).toBe("selfie_not_real_photograph")

      const response = await recordInPerson(fixture.clientId)
      expect(response.status).toBe(200)
      expect((await kyc(fixture.clientId)).kycStatus).toBe("VERIFIED")
    })
  })

  describe("the ID copy a selfie is compared against", () => {
    it("is the newest upload, but a match against a rejected copy verifies nobody, in either layer", async () => {
      // The breaker's case: verified A, a newer doctored B that staff rejected,
      // and a selfie that matches B.
      const fixture = await seedClient()
      const rejected = await addIdCopy(fixture, "rejected", { verified: false, contentSha256: "b".repeat(64), rejected: true })
      stubVlm(passingReply())
      const { selfie } = await capture(fixture)

      expect(ctx.readPaths).toEqual([`stub/rejected-${sequence}`])
      expect(selfie?.biometricResult).toEqual(expect.objectContaining({
        idDocumentId: rejected, idDocumentSha256: "b".repeat(64), biometricFailureReason: null,
      }))
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
      expect(await layers(fixture.clientId)).toEqual({ app: false, appReason: "subject_identity_changed", sql: false })
      await expect(db.client.update({
        where: { id: fixture.clientId },
        data: { kycStatus: "VERIFIED", kycVerifiedAt: new Date(), kycVerificationMethod: "BIOMETRIC" },
      })).rejects.toThrow("Client KYC cannot be VERIFIED without current composite evidence")
    })

    it("counts the match once staff verify the copy it was run against", async () => {
      const fixture = await seedClient()
      const newer = await addIdCopy(fixture, "awaiting", { verified: false, contentSha256: "b".repeat(64) })
      stubVlm(passingReply())
      const { selfie } = await capture(fixture)

      // The borrower did not wait for staff; the match is stored but does not count yet.
      expect((selfie?.biometricResult as Record<string, unknown>).idDocumentId).toBe(newer)
      expect(selfie?.verified).toBe(true)
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
      expect(await layers(fixture.clientId)).toEqual({ app: false, appReason: "subject_identity_changed", sql: false })

      // Staff verify the new copy through the normal document-verify route,
      // which re-derives the client's KYC: the copy is now the newest verified
      // one, so the match counts. The roll-up names the method from the
      // document that completed it (an ID copy: PHYSICAL), as for any core
      // document verified after the selfie.
      const response = await verifyDocument(fixture.clientId, newer)
      expect(response.status).toBe(200)
      expect(await kyc(fixture.clientId)).toEqual({ kycStatus: "VERIFIED", kycVerificationMethod: "PHYSICAL" })
      expect(await layers(fixture.clientId)).toEqual({ app: true, appReason: null, sql: true })
    })

    it("fails a match whose ID copy was replaced while the check ran", async () => {
      const fixture = await seedClient()
      stubVlm(passingReply())
      // Compared against A; B lands before the callback persists.
      await addIdCopy(fixture, "replacement", { verified: false, contentSha256: "b".repeat(64) })
      const selfie = await attemptAgainst(fixture, fixture.idCopyId)

      expect(selfie.verified).toBe(false)
      expect(reasonOf(selfie)).toBe("subject_identity_changed")
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
    })

    it("lapses biometric KYC when a newer ID copy is verified after the match", async () => {
      const fixture = await seedClient()
      stubVlm(passingReply())
      await capture(fixture)
      expect((await kyc(fixture.clientId)).kycStatus).toBe("VERIFIED")

      // Uploaded but unverified: the verified copy the match rests on still governs.
      const newer = await addIdCopy(fixture, "newer", { verified: false, contentSha256: "b".repeat(64) })
      expect((await kyc(fixture.clientId)).kycStatus).toBe("VERIFIED")

      // Verified: the match no longer describes the ID the KYC rests on, and
      // ClientDocument_revoke_stale_composite_kyc demotes the client.
      await db.clientDocument.update({ where: { id: newer }, data: { verified: true, verifiedAt: new Date() } })
      expect(await kyc(fixture.clientId)).toEqual({ kycStatus: "PENDING", kycVerificationMethod: null })
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: fixture.clientId, userEmail: "database@composite-kyc-guard" },
        select: { newValue: true },
      })
      expect(audit.newValue).toEqual(expect.objectContaining({
        reason: "composite_kyc_evidence_changed", documentId: newer, documentType: "ID_COPY",
      }))
    })
  })

  describe("the face model decides same-person", () => {
    it("verifies the client on a VLM pass the face model confirms, in both layers", async () => {
      const fixture = await seedClient()
      stubVlm(passingReply())
      const { selfie } = await capture(fixture)

      expect(selfie?.verified).toBe(true)
      expect(selfie?.biometricResult).toEqual(expect.objectContaining({
        provider: "vlm-face-match-v3", faceModel: expect.objectContaining({ samePerson: true }),
      }))
      expect(await kyc(fixture.clientId)).toEqual({ kycStatus: "VERIFIED", kycVerificationMethod: "BIOMETRIC" })
      expect(await layers(fixture.clientId)).toEqual({ app: true, appReason: null, sql: true })
    })

    it("refuses a confident VLM \"same\" the face model scored below the threshold", async () => {
      const fixture = await seedClient()
      const { PASSING_FACE_MODEL_EVIDENCE } = await import("@/lib/kyc/face-model/evidence.test-helpers")
      ctx.comparison = {
        ok: true,
        evidence: { ...PASSING_FACE_MODEL_EVIDENCE, similarity: 0.12, samePerson: false },
        rejection: { reason: "match_score_below_threshold", message: "Face comparison similarity below threshold" },
      }
      stubVlm(passingReply({ matchConfidence: 0.95 }))
      const { selfie } = await capture(fixture)

      expect(selfie?.verified).toBe(false)
      // The stored provider result does not claim a pass the model refused.
      expect((selfie?.biometricResult as Record<string, unknown>).verified).toBe(false)
      expect(reasonOf(selfie)).toBe("match_score_below_threshold")
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
      expect((await layers(fixture.clientId)).sql).toBe(false)
      // Written straight to the database, the stored model refusal still blocks.
      await expect(db.client.update({
        where: { id: fixture.clientId },
        data: { kycStatus: "VERIFIED", kycVerifiedAt: new Date(), kycVerificationMethod: "BIOMETRIC" },
      })).rejects.toThrow("Client KYC cannot be VERIFIED without current composite evidence")
    })

    it("closes the in-person route over an ID copy on which the face model found no face", async () => {
      const fixture = await seedClient()
      ctx.comparison = {
        ok: false,
        rejection: { reason: "id_document_portrait_invalid", message: "No face found in the ID document photograph by the face comparison" },
        idFaceCount: 0, selfieFaceCount: 1,
      }
      stubVlm(passingReply())
      const { selfie } = await capture(fixture)
      expect(reasonOf(selfie)).toBe("id_document_portrait_invalid")

      const response = await recordInPerson(fixture.clientId)
      expect(response.status).toBe(422)
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
    })

    it("records extraction_incomplete, which no senior may except, when the face model is unavailable", async () => {
      const fixture = await seedClient()
      ctx.comparison = {
        ok: false,
        rejection: { reason: "extraction_incomplete", message: "Face comparison could not run: the face models are unavailable" },
        idFaceCount: null, selfieFaceCount: null,
      }
      stubVlm(passingReply())
      const { selfie } = await capture(fixture)
      expect(selfie?.verified).toBe(false)
      expect(reasonOf(selfie)).toBe("extraction_incomplete")

      const response = await recordException(fixture.clientId)
      expect(response.status).toBe(422)
      expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
    })
  })

  it("records extraction_incomplete, which no senior may except, when the reply judges neither photo", async () => {
    const fixture = await seedClient()
    const reply: Record<string, unknown> = passingReply({ faceDetected: false })
    delete reply.idPhotoKind
    delete reply.idPhotoIsRealPhotograph
    delete reply.idPhotoFaceDetected
    delete reply.selfieIsRealPhotograph
    stubVlm(reply)
    const { selfie } = await capture(fixture)
    expect(reasonOf(selfie)).toBe("extraction_incomplete")

    const response = await recordException(fixture.clientId)
    expect(response.status).toBe(422)
    expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
  })

  it("refuses a selfie whose quality answer carries a trailing newline, in both layers", async () => {
    const fixture = await seedClient()
    stubVlm(passingReply({ quality: "good\n" }))
    const { selfie } = await capture(fixture)

    expect(selfie?.verified).toBe(false)
    expect(reasonOf(selfie)).toBe("biometric_evidence_missing")
    expect((await kyc(fixture.clientId)).kycStatus).not.toBe("VERIFIED")
  })
})
