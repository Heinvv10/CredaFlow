/**
 * Shared fixtures for the real-database selfie sweeper suites
 * (selfie-sweeper.integration.test.ts, in-person-lapse-pipeline.integration.test.ts).
 * Each suite owns its vi.mock calls and its own session context; this file
 * only seeds rows and reads them back.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { vi } from "vitest"
import sharp from "sharp"
import { runWithTenant } from "@/lib/tenant-scope"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"
import { sweepStuckSelfies, SELFIE_PROCESSING_TIMEOUT_MS } from "@/lib/kyc/selfie-sweeper.server"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"

export const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
export const ID_SHA = "a".repeat(64)
export const SELFIE_JPEG = await sharp({ create: { width: 40, height: 52, channels: 3, background: "#b08060" } }).jpeg().toBuffer()
export const STALE_MS = SELFIE_PROCESSING_TIMEOUT_MS + 60_000
let sequence = 0

export type Fixture = { tenantId: string; clientId: string; idCopyId: string; adminId: string }
export type Attempt = { selfieId: string; generation: string }

export const reply = (change: Record<string, unknown> = {}) => ({
  faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
  selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true, samePerson: "same", faceMatch: true, matchConfidence: 0.93, ...change,
})
export const different = () => reply({ samePerson: "different", faceMatch: false, matchConfidence: 0.08 })
export const silhouette = () => reply({ idPhotoKind: "silhouette_placeholder", idPhotoIsRealPhotograph: false, idPhotoFaceDetected: false })

export function stubVlm(body: Record<string, unknown>) {
  vi.stubEnv("VLM_API_URL", "http://vlm.stub.invalid")
  vi.stubEnv("VLM_MODEL", "stub-model")
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(body) } }],
  }), { status: 200 })))
}

/** A PENDING client with four verified core documents and an admin. */
export async function seedClient(): Promise<Fixture> {
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
  return { tenantId, clientId, idCopyId: `sweep_ID_COPY_${sequence}_${token}`, adminId: admin.id }
}

/** A selfie attempt whose lease started `ageMs` ago and whose worker has not answered. */
export async function attempt(
  fixture: Fixture,
  ageMs: number,
  over: { createdAt?: Date; data?: Record<string, unknown> } = {},
): Promise<Attempt> {
  const selfieId = `sweep_selfie_${sequence}_${randomUUID().slice(0, 8)}`
  const generation = randomUUID()
  const startedAt = new Date(Date.now() - ageMs)
  await db.clientDocument.create({
    data: {
      id: selfieId, tenantId: fixture.tenantId, clientId: fixture.clientId, docType: "SELFIE", fileUrl: "",
      fileName: "selfie.jpg", mimeType: "image/jpeg", storagePath: "stub/selfie", contentSha256: "e".repeat(64),
      uploadedByType: "client", extractionStatus: "processing", extractionGeneration: generation,
      extractionStartedAt: startedAt, createdAt: over.createdAt ?? startedAt, ...over.data,
    },
  })
  return { selfieId, generation }
}

export const sweep = (f: Fixture) => runWithTenant(f.tenantId, () => sweepStuckSelfies(f.tenantId, new Date()))

export const row = (id: string) => db.clientDocument.findUniqueOrThrow({
  where: { id },
  select: {
    extractionStatus: true, verified: true, biometricResult: true, biometricVerifiedAt: true,
    verificationNote: true, verificationRejectedById: true,
  },
})
export const reasonOf = (r: { biometricResult: unknown }) =>
  (r.biometricResult as Record<string, unknown> | null)?.biometricFailureReason
export const kycStatus = async (clientId: string) =>
  (await db.client.findUniqueOrThrow({ where: { id: clientId }, select: { kycStatus: true } })).kycStatus
export const audits = (entityId: string) => db.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } })
export const isLateAudit = (l: { newValue: unknown }) =>
  (l.newValue as { document?: { lateAfterSweep?: boolean } } | null)?.document?.lateAfterSweep === true

/** A worker's answer landing on `a` against `idDocumentId`, as a delayed callback would. */
export async function lateAnswer(f: Fixture, a: Attempt, idDocumentId = f.idCopyId) {
  const idDocument = await db.clientDocument.findUniqueOrThrow({
    where: { id: idDocumentId }, select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
  })
  await runWithTenant(f.tenantId, () => runBiometricVerification(
    a.selfieId, f.clientId, f.tenantId, a.generation, SELFIE_JPEG, "image/jpeg", idDocument,
  ))
  return row(a.selfieId)
}

/** Both layers' verdict on the composite KYC. */
export async function layers(clientId: string) {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } })
  const app = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId: client.tenantId, clientId, subject: client, existing: client,
  })
  const [{ ok }] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT "client_has_composite_kyc"($1, $2) AS ok`, client.tenantId, clientId,
  )
  return { app: app.ok, sql: ok, failed: app.biometricAttemptFailed }
}

/** A newer ID copy for the client. */
export async function addVerifiedIdCopy(f: Fixture, label: string, sha: string) {
  const id = `sweep_ID_${label}_${sequence}_${token}`
  await db.clientDocument.create({
    data: {
      id, tenantId: f.tenantId, clientId: f.clientId, docType: "ID_COPY", fileUrl: "", fileName: `${label}.jpg`,
      mimeType: "image/jpeg", storagePath: `stub/${label}`, contentSha256: sha, uploadedByType: "client",
      verified: true, verifiedAt: new Date(),
    },
  })
  return id
}
