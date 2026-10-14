/**
 * Real-database proof for the stuck-selfie sweeper and for a worker's late
 * answer after its attempt was swept. Only the VLM HTTP call, the face model's
 * comparison, file storage and session/tenant resolution are stubbed; the
 * composite-KYC triggers, the revoke trigger and both gates run for real.
 *
 *   RUN_SELFIE_SWEEPER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/selfie-sweeper.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import sharp from "sharp"

const ctx = vi.hoisted(() => ({ tenantId: "", adminId: "" }))
vi.mock("@/lib/kyc/face-model/compare.server", async () => {
  const { PASSING_FACE_MODEL_EVIDENCE } = await import("@/lib/kyc/face-model/evidence.test-helpers")
  return { compareFaces: vi.fn(async () => ({ ok: true, evidence: PASSING_FACE_MODEL_EVIDENCE, rejection: null })) }
})
vi.mock("@/lib/storage", async () => {
  const sharp = (await import("sharp")).default
  const idJpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#d0c8b0" } }).jpeg().toBuffer()
  return {
    readFile: vi.fn(async () => idJpeg),
    saveFile: vi.fn(async () => ({ storagePath: "stub/selfie", fileSize: 12 })),
    deleteFile: vi.fn(async () => undefined),
  }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.adminId, email: `${ctx.adminId}@test.invalid`, role: "ADMIN", totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
      runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
    getDefaultTenantId: async () => ctx.tenantId,
  }
})

import { runWithTenant } from "@/lib/tenant-scope"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"
import { sweepStuckSelfies, SELFIE_PROCESSING_TIMEOUT_MS } from "@/lib/kyc/selfie-sweeper.server"
import { POST as inPersonPOST } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import { POST as exceptionPOST } from "@/app/api/clients/[id]/kyc-exception/route"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"

const RUN = process.env.RUN_SELFIE_SWEEPER_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const ID_SHA = "a".repeat(64)
const SELFIE_JPEG = await sharp({ create: { width: 40, height: 52, channels: 3, background: "#b08060" } }).jpeg().toBuffer()
let sequence = 0

const reply = (change: Record<string, unknown> = {}) => ({
  faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
  selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true, samePerson: "same", faceMatch: true, matchConfidence: 0.93, ...change,
})
const different = () => reply({ samePerson: "different", faceMatch: false, matchConfidence: 0.08 })
const silhouette = () => reply({ idPhotoKind: "silhouette_placeholder", idPhotoIsRealPhotograph: false, idPhotoFaceDetected: false })

function stubVlm(body: Record<string, unknown>) {
  vi.stubEnv("VLM_API_URL", "http://vlm.stub.invalid")
  vi.stubEnv("VLM_MODEL", "stub-model")
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(body) } }],
  }), { status: 200 })))
}

type Fixture = { tenantId: string; clientId: string; idCopyId: string }

/** A PENDING client with four verified core documents. */
async function seedClient(): Promise<Fixture> {
  sequence += 1
  const tenantId = `t_sweep_${sequence}_${token}`
  const clientId = `c_sweep_${sequence}_${token}`
  await db.tenant.create({ data: { id: tenantId, slug: `sweep-${sequence}-${token}`, name: "Sweeper" } })
  await db.client.create({
    data: {
      id: clientId, tenantId, reference: `CLI-SWEEP-${sequence}-${token}`, idNumber: `SWEEP-${sequence}-${token}`,
      firstName: "Synthetic", lastName: "Sweeper", email: `sweep-${sequence}-${token}@test.invalid`, phone: "+27820000067",
    },
  })
  const createdAt = new Date(Date.now() - 3_600_000)
  await db.clientDocument.createMany({
    data: (["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"] as const).map((docType) => ({
      id: `sweep_${docType}_${sequence}_${token}`, tenantId, clientId, docType, fileUrl: "", fileName: "core.jpg",
      mimeType: "image/jpeg", storagePath: `stub/${docType}`, contentSha256: ID_SHA, verified: true,
      verifiedAt: createdAt, createdAt,
    })),
  })
  const admin = await db.user.create({
    data: {
      email: `sweep-admin-${sequence}-${token}@test.invalid`, password: "x", role: "ADMIN", tenantId,
      active: true, totpEnabled: true, lastTotpCounter: 1,
    },
  })
  ctx.tenantId = tenantId
  ctx.adminId = admin.id
  return { tenantId, clientId, idCopyId: `sweep_ID_COPY_${sequence}_${token}` }
}

/** A selfie attempt claimed `ageMs` ago whose worker has not answered. */
async function attempt(fixture: Fixture, ageMs: number) {
  const selfieId = `sweep_selfie_${sequence}_${randomUUID().slice(0, 8)}`
  const generation = randomUUID()
  const startedAt = new Date(Date.now() - ageMs)
  await db.clientDocument.create({
    data: {
      id: selfieId, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "SELFIE", fileUrl: "",
      fileName: "selfie.jpg", mimeType: "image/jpeg", storagePath: "stub/selfie", contentSha256: "e".repeat(64),
      uploadedByType: "client", extractionStatus: "processing", extractionGeneration: generation,
      extractionStartedAt: startedAt, createdAt: startedAt,
    },
  })
  return { selfieId, generation }
}

const STALE_MS = SELFIE_PROCESSING_TIMEOUT_MS + 60_000
const sweep = (f: Fixture) => runWithTenant(f.tenantId, () => sweepStuckSelfies(f.tenantId, new Date()))
const row = (id: string) => db.clientDocument.findUniqueOrThrow({
  where: { id },
  select: { extractionStatus: true, verified: true, biometricResult: true, biometricVerifiedAt: true },
})
const reasonOf = (r: { biometricResult: unknown }) =>
  (r.biometricResult as Record<string, unknown> | null)?.biometricFailureReason
const kycStatus = async (clientId: string) =>
  (await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { kycStatus: true } })).kycStatus
const audits = (entityId: string) => db.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } })

/** A worker's answer landing on `a`, as a delayed callback would. */
async function lateAnswer(f: Fixture, a: { selfieId: string; generation: string }) {
  const idDocument = await db.clientDocument.findUniqueOrThrow({
    where: { id: f.idCopyId }, select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
  })
  await runWithTenant(f.tenantId, () => runBiometricVerification(
    a.selfieId, f.clientId, f.tenantId, a.generation, SELFIE_JPEG, "image/jpeg", idDocument,
  ))
  return row(a.selfieId)
}

async function layers(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId: client.tenantId, clientId, subject: client, existing: client,
  })
  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "client_has_composite_kyc"($1, $2) AS ok`, client.tenantId, clientId,
  )
  return { app: app.ok, sql: ok, failed: app.biometricAttemptFailed }
}

const inPerson = (clientId: string) => inPersonPOST(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({ method: "IN_PERSON_BRANCH", note: "Synthetic applicant attended a branch and matched the ID photo." }),
}) as never, { params: Promise.resolve({ id: clientId }) })

suite("stuck selfie sweeper", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("fails a stale processing attempt as an adverse, non-verifying result, and audits it", async () => {
    const f = await seedClient()
    const stuck = await attempt(f, STALE_MS)

    expect(await sweep(f)).toEqual({ swept: 1 })
    const swept = await row(stuck.selfieId)
    expect(swept).toMatchObject({ extractionStatus: "failed", verified: false, biometricVerifiedAt: null })
    expect(reasonOf(swept)).toBe("biometric_outcome_not_recorded")
    expect(await kycStatus(f.clientId)).toBe("FAILED")
    expect(await layers(f.clientId)).toEqual({ app: false, sql: false, failed: true })
    // Adverse, so no senior exception can be granted over it.
    expect((await exceptionPOST(new Request("http://localhost/", {
      method: "POST",
      body: JSON.stringify({ reason: "Synthetic senior exception.", supportingEvidence: "Synthetic review of documents." }),
    }) as never, { params: Promise.resolve({ id: f.clientId }) })).status).toBe(422)

    const log = (await audits(stuck.selfieId)).find((a) => a.userEmail === "system@selfie-sweeper")
    expect(log).toMatchObject({ action: "KYC_REJECTED", entity: "ClientDocument", tenantId: f.tenantId })
    expect(log?.newValue).toMatchObject({ document: { extractionStatus: "failed", latestSelfie: true } })

    expect(await sweep(f)).toEqual({ swept: 0 })
  })

  it("leaves an attempt inside the timeout alone", async () => {
    const f = await seedClient()
    const live = await attempt(f, SELFIE_PROCESSING_TIMEOUT_MS - 60_000)
    expect(await sweep(f)).toEqual({ swept: 0 })
    expect((await row(live.selfieId)).extractionStatus).toBe("processing")
  })

  it("does not re-project the client over a swept attempt that a newer selfie superseded", async () => {
    const f = await seedClient()
    const older = await attempt(f, STALE_MS + 60_000)
    const newer = await attempt(f, 60_000)
    expect(await sweep(f)).toEqual({ swept: 1 })
    expect((await row(older.selfieId)).extractionStatus).toBe("failed")
    expect((await row(newer.selfieId)).extractionStatus).toBe("processing")
    expect((await audits(older.selfieId)).find((a) => a.userEmail === "system@selfie-sweeper")?.newValue)
      .toMatchObject({ document: { latestSelfie: false } })
  })

  describe("a worker's late answer after the sweep", () => {
    it("records an adverse answer for the current attempt and audits it", async () => {
      const f = await seedClient()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(after.extractionStatus).toBe("failed")
      expect(after.verified).toBe(false)
      expect(reasonOf(after)).not.toBe("biometric_outcome_not_recorded")
      expect((after.biometricResult as Record<string, unknown>).swept).toBeUndefined()
      expect((await audits(a.selfieId)).some((l) =>
        (l.newValue as { document?: { lateAfterSweep?: boolean } } | null)?.document?.lateAfterSweep === true)).toBe(true)
      expect(await kycStatus(f.clientId)).toBe("FAILED")
    })

    it("ignores a late pass: a swept attempt never verifies", async () => {
      const f = await seedClient()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      stubVlm(reply())
      const after = await lateAnswer(f, a)
      expect(after).toMatchObject({ extractionStatus: "failed", verified: false, biometricVerifiedAt: null })
      expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
      expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    })

    it("ignores a stale answer for an attempt a newer selfie superseded", async () => {
      const f = await seedClient()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      await attempt(f, 1_000)
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
      expect((await audits(a.selfieId)).some((l) =>
        (l.newValue as { document?: { lateAfterSweep?: boolean } } | null)?.document?.lateAfterSweep === true)).toBe(false)
    })

    it("revokes a client verified in person when the late answer is a refused ID portrait", async () => {
      const f = await seedClient()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      expect((await inPerson(f.clientId)).status).toBe(200)
      expect(await kycStatus(f.clientId)).toBe("VERIFIED")

      stubVlm(silhouette())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).toBe("id_document_portrait_invalid")
      expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
      expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
      const logs = await audits(a.selfieId)
      const late = logs.find((l) => (l.newValue as { document?: { lateAfterSweep?: boolean } } | null)?.document?.lateAfterSweep === true)
      expect(late?.oldValue).toMatchObject({ clientKyc: { kycStatus: "VERIFIED" } })
      expect(late?.newValue).toMatchObject({ clientKyc: { kycStatus: expect.not.stringMatching(/^VERIFIED$/) } })
    })

    // POLICY PIN, not an endorsement: an in-person attestation survives a face
    // mismatch in both layers (in-person-verification.ts), so a late "different"
    // is recorded but cannot lapse it. Changing that needs SQL and TS together.
    it("records a late mismatch but leaves an in-person attestation standing", async () => {
      const f = await seedClient()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      expect((await inPerson(f.clientId)).status).toBe(200)
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).not.toBe("biometric_outcome_not_recorded")
      expect(await kycStatus(f.clientId)).toBe("VERIFIED")
    })
  })
})
