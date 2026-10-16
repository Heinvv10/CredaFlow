/**
 * Real-Postgres proof that an identical ID re-upload IS the verified copy for
 * the selfie (product decision 2026-10-16): a newer, unverified ID copy whose
 * well-formed digest equals the newest verified copy's binds the selfie to
 * that verified copy, at capture and again when the outcome is recorded. A
 * copy of different bytes still binds the selfie to itself, unchanged.
 *
 * Runs the real pipeline (captureSelfie -> runBiometricVerification ->
 * persistBiometricOutcome) and asks both layers for the composite verdict:
 * readCompositeKycState and client_has_composite_kyc. Only the VLM HTTP call,
 * the face model's comparison, file storage and tenant resolution are stubbed,
 * as in face-match-v3-pipeline.integration.test.ts.
 *
 *   RUN_KYC_ID_TWIN_SELFIE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/id-identical-twin-selfie.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import sharp from "sharp"

const ctx = vi.hoisted(() => ({ tenantId: "", readPaths: [] as string[] }))
vi.mock("@/lib/kyc/face-model/compare.server", async () => {
  const { PASSING_FACE_MODEL_EVIDENCE } = await import("@/lib/kyc/face-model/evidence.test-helpers")
  return { compareFaces: vi.fn(async () => ({ ok: true, evidence: PASSING_FACE_MODEL_EVIDENCE, rejection: null })) }
})
vi.mock("@/lib/storage", async () => {
  const sharp = (await import("sharp")).default
  const idJpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#d0c8b0" } }).jpeg().toBuffer()
  return {
    readFile: vi.fn(async (storagePath: string) => {
      ctx.readPaths.push(storagePath)
      return idJpeg
    }),
    saveFile: vi.fn(async () => ({ storagePath: `stub/selfie-${Math.random()}`, fileSize: 12 })),
    deleteFile: vi.fn(async () => undefined),
  }
})
// lib/document-auth (the selfie magic-byte check) imports the NextAuth config.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
      runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
    getDefaultTenantId: async () => ctx.tenantId,
  }
})

import { runWithTenant } from "@/lib/tenant-scope"
import { captureSelfie } from "@/lib/kyc/selfie-capture.server"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const RUN = process.env.RUN_KYC_ID_TWIN_SELFIE_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const ID_SHA = "a".repeat(64)
const OTHER_SHA = "b".repeat(64)
let sequence = 0

type Fixture = { tenantId: string; clientId: string; verifiedId: string }

/** A PENDING client with four verified core documents; the ID copy is hashed. */
async function seedClient(): Promise<Fixture> {
  sequence += 1
  const tenantId = `t_idtwin_${sequence}_${token}`
  const clientId = `c_idtwin_${sequence}_${token}`
  await db.tenant.create({ data: { id: tenantId, slug: `idtwin-${sequence}-${token}`, name: "Identical twin" } })
  await db.client.create({ data: {
    id: clientId, tenantId, reference: `CLI-IDTWIN-${sequence}-${token}`, idNumber: `IDTWIN-${sequence}-${token}`,
    firstName: "Synthetic", lastName: "Twin", email: `idtwin-${sequence}-${token}@test.invalid`, phone: "+27820000069",
  } })
  const createdAt = new Date(Date.now() - 60_000)
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
      id: `idtwin_${docType}_${sequence}_${token}`, tenantId, clientId, docType, fileUrl: "",
      fileName: "core.jpg", mimeType: "image/jpeg", storagePath: `stub/${docType}-${sequence}`,
      contentSha256: ID_SHA, verified: true, verifiedAt: createdAt, createdAt,
    })),
  })
  ctx.tenantId = tenantId
  return { tenantId, clientId, verifiedId: `idtwin_ID_COPY_${sequence}_${token}` }
}

/** A newer, unverified ID copy the client uploaded. */
async function reupload(fixture: Fixture, label: string, contentSha256: string) {
  const id = `idtwin_ID_${label}_${sequence}_${token}`
  await db.clientDocument.create({ data: {
    id, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "ID_COPY", fileUrl: "",
    fileName: `${label}.jpg`, mimeType: "image/jpeg", storagePath: `stub/${label}-${sequence}`,
    contentSha256, uploadedByType: "client", verified: false,
  } })
  return id
}

function stubPassingVlm() {
  vi.stubEnv("VLM_API_URL", "http://vlm.stub.invalid")
  vi.stubEnv("VLM_MODEL", "stub-model")
  const reply = {
    faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
    selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true, samePerson: "same", faceMatch: true, matchConfidence: 0.93,
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(reply) } }],
  }), { status: 200 })))
}

const SELFIE_JPEG = await sharp({ create: { width: 40, height: 52, channels: 3, background: "#b08060" } }).jpeg().toBuffer()

/** Capture through the real entry point and wait for the async face match. */
async function capture(fixture: Fixture) {
  const result = await runWithTenant(fixture.tenantId, () => captureSelfie({
    tenantId: fixture.tenantId, clientId: fixture.clientId,
    image: new File([new Uint8Array(SELFIE_JPEG)], "selfie.jpg", { type: "image/jpeg" }),
    uploader: { type: "client", clientId: fixture.clientId, email: null },
  }))
  if (!result.ok) throw new Error(`capture refused: ${result.error}`)
  await vi.waitFor(async () => {
    const row = await db.clientDocument.findUniqueOrThrow({ where: { id: result.documentId } })
    expect(row.extractionStatus).not.toBe("processing")
  }, { timeout: 10_000, interval: 50 })
  return selfie(result.documentId)
}

async function selfie(id: string) {
  const row = await db.clientDocument.findUniqueOrThrow({
    where: { id }, select: { extractionStatus: true, verified: true, biometricResult: true },
  })
  const result = row.biometricResult as Record<string, unknown>
  return { status: row.extractionStatus, verified: row.verified, boundTo: result.idDocumentId, reason: result.biometricFailureReason }
}

/** The stored status, and the composite verdict of the app and of the database. */
async function verdict(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId: client.tenantId, clientId, subject: client, existing: client,
  })
  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "client_has_composite_kyc"($1, $2) AS ok`, client.tenantId, clientId,
  )
  return { stored: client.kycStatus, method: client.kycVerificationMethod, app: app.ok, sql: ok }
}

suite("an identical ID re-upload is the verified copy for the selfie", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    ctx.readPaths = []
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("binds a selfie taken after an identical re-upload to the verified copy, and it passes", async () => {
    const fixture = await seedClient()
    await reupload(fixture, "twin", ID_SHA)
    stubPassingVlm()

    expect(await capture(fixture)).toEqual({ status: "done", verified: true, boundTo: fixture.verifiedId, reason: null })
    expect(ctx.readPaths).toContain(`stub/ID_COPY-${sequence}`)
    // The attempt row keeps the selfie's own digest, not the ID copy's.
    const [attempt] = await db.clientDocument.findMany({ where: { clientId: fixture.clientId, docType: "SELFIE" } })
    expect(attempt.contentSha256).toBe(sha256DocumentBytes(SELFIE_JPEG))
    expect(await verdict(fixture.clientId)).toEqual({ stored: "VERIFIED", method: "BIOMETRIC", app: true, sql: true })
  })

  it("still passes when the identical copy lands while the match is in flight", async () => {
    const fixture = await seedClient()
    const selfieId = `idtwin_selfie_${sequence}_${token}`
    const generation = randomUUID()
    await db.clientDocument.create({ data: {
      id: selfieId, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "SELFIE",
      fileUrl: "", fileName: "selfie.jpg", mimeType: "image/jpeg", storagePath: "stub/selfie",
      contentSha256: "e".repeat(64), uploadedByType: "client", extractionStatus: "processing",
      extractionGeneration: generation, extractionStartedAt: new Date(),
    } })
    await reupload(fixture, "twin-in-flight", ID_SHA)
    stubPassingVlm()
    const verifiedCopy = await db.clientDocument.findUniqueOrThrow({
      where: { id: fixture.verifiedId }, select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
    })
    await runWithTenant(fixture.tenantId, () => runBiometricVerification(
      selfieId, fixture.clientId, fixture.tenantId, generation, SELFIE_JPEG, "image/jpeg", verifiedCopy,
    ))

    expect(await selfie(selfieId)).toEqual({ status: "done", verified: true, boundTo: fixture.verifiedId, reason: null })
    expect(await verdict(fixture.clientId)).toEqual({ stored: "VERIFIED", method: "BIOMETRIC", app: true, sql: true })
  })

  it("binds a selfie taken after a different re-upload to that new copy, unchanged", async () => {
    const fixture = await seedClient()
    const different = await reupload(fixture, "different", OTHER_SHA)
    stubPassingVlm()

    // The match is stored against the new copy and proves nothing about the
    // verified identity: a failed attempt while a verified copy is on file.
    expect(await capture(fixture)).toEqual({ status: "done", verified: true, boundTo: different, reason: null })
    expect(await verdict(fixture.clientId)).toEqual({ stored: "FAILED", method: null, app: false, sql: false })
  })

  it("binds a selfie to an identical copy of an OLDER verified copy, not the current one", async () => {
    const fixture = await seedClient()
    const current = await reupload(fixture, "current", OTHER_SHA)
    await db.clientDocument.update({ where: { id: current }, data: { verified: true, verifiedAt: new Date() } })
    // Same bytes as the superseded verified copy (ID_SHA), not as the current one.
    const stale = await reupload(fixture, "stale-twin", ID_SHA)
    stubPassingVlm()

    expect(await capture(fixture)).toEqual({ status: "done", verified: true, boundTo: stale, reason: null })
    expect(await verdict(fixture.clientId)).toEqual(expect.objectContaining({ app: false, sql: false }))
  })
})
