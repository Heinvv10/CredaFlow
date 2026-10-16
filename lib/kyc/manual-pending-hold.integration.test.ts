/**
 * Real-Postgres proof that a staff member's deliberate manual PENDING holds
 * against every automatic path that would roll the client up to VERIFIED:
 * the document verify and refuse route, a staff document delete and a passed
 * selfie. Each case runs with and without the hold, so the path is shown to
 * promote on its own. A FAILED in between (a refusal, a failed selfie) does
 * not open a way out; Approve KYC ends the hold.
 *
 * The routes and the selfie pipeline run for real. Stubbed: session and
 * tenant resolution, file storage, the VLM HTTP call (fetch) and the face
 * model's comparison (compareFaces), whose evidence both real gates re-prove.
 *
 *   RUN_KYC_REDERIVE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/manual-pending-hold.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import sharp from "sharp"

const ctx = vi.hoisted(() => ({ userId: "", tenantId: "", session: null as null | { user: Record<string, unknown> } }))
vi.mock("@/lib/kyc/face-model/compare.server", async () => {
  const { PASSING_FACE_MODEL_EVIDENCE } = await import("@/lib/kyc/face-model/evidence.test-helpers")
  return { compareFaces: vi.fn(async () => ({ ok: true, evidence: PASSING_FACE_MODEL_EVIDENCE, rejection: null })) }
})
vi.mock("@/lib/storage", async () => {
  const sharp = (await import("sharp")).default
  const idJpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#d0c8b0" } }).jpeg().toBuffer()
  return { readFile: vi.fn(async () => idJpeg), deleteFile: vi.fn(async () => undefined) }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ctx.session) }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: `${ctx.userId}@test.invalid`, role: "CREDIT_OFFICER", totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
      runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
    getTenantFromRequest: async () => ({ id: ctx.tenantId }),
    getDefaultTenantId: async () => ctx.tenantId,
  }
})

import { PATCH as setKycStatus } from "@/app/api/clients/[id]/route"
import { PATCH as verify } from "@/app/api/clients/[id]/documents/[docId]/verify/route"
import { DELETE as deleteDocument } from "@/app/api/documents/[id]/route"
import { B, C, rederiveFixture } from "@/lib/kyc/kyc-rederive.integration-fixture"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"
import { runWithTenant } from "@/lib/tenant-scope"

const RUN = process.env.RUN_KYC_REDERIVE_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_mphold_${token}`
ctx.tenantId = tenantId
const attesterId = `attester_mphold_${token}`
const officer = `officer_mphold_${token}`
const superAdmin = `super_mphold_${token}`
const { seedClient, seedRestorableClient } = rederiveFixture(db, { tenantId, token, attesterId, label: "mphold" })
const SELFIE_JPEG = await sharp({ create: { width: 40, height: 52, channels: 3, background: "#b08060" } }).jpeg().toBuffer()

const json = (method: string, body?: unknown) => new NextRequest("http://localhost/", {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const status = async (clientId: string) => (await db.client.findUniqueOrThrow({ where: { id: clientId } })).kycStatus
async function holdIf(held: boolean, clientId: string) {
  if (!held) return
  ctx.userId = officer
  expect((await setKycStatus(json("PATCH", { kycStatus: "PENDING" }), { params: Promise.resolve({ id: clientId }) })).status).toBe(200)
}
const verifyDoc = (clientId: string, docId: string, body: Record<string, unknown> = { verified: true }) => {
  ctx.userId = officer
  return verify(json("PATCH", body), { params: Promise.resolve({ id: clientId, docId }) })
}

/** A selfie attempt claimed for processing, then the real pipeline with a passing (or failing) VLM reply. */
async function passSelfie(clientId: string, idCopyId: string, opts: { suffix?: string; pass?: boolean } = {}) {
  const pass = opts.pass ?? true
  vi.stubEnv("VLM_API_URL", "http://vlm.stub.invalid")
  vi.stubEnv("VLM_MODEL", "stub-model")
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    faceDetected: true, facesCount: 1, quality: "good", isLive: true, livenessConfidence: 0.95,
    selfieIsRealPhotograph: true, idPhotoKind: "photograph", idPhotoIsRealPhotograph: true,
    idPhotoFaceDetected: true, samePerson: pass ? "same" : "different", faceMatch: pass, matchConfidence: pass ? 0.93 : 0.05,
  }) } }] }), { status: 200 })))
  const selfieId = `selfie${opts.suffix ?? ""}_${clientId}`
  const generation = randomUUID()
  await db.clientDocument.create({ data: {
    id: selfieId, tenantId, clientId, docType: "SELFIE", fileUrl: "", fileName: "selfie.jpg", mimeType: "image/jpeg",
    storagePath: "stub/selfie", contentSha256: "e".repeat(64), uploadedByType: "client", extractionStatus: "processing",
    extractionGeneration: generation, extractionStartedAt: new Date(), createdAt: new Date(),
  } })
  await runWithTenant(tenantId, () => runBiometricVerification(selfieId, clientId, tenantId, generation, SELFIE_JPEG, "image/jpeg", {
    id: idCopyId, storagePath: "stub/id", mimeType: "image/jpeg", contentSha256: "a".repeat(64),
  }))
  return db.clientDocument.findUniqueOrThrow({ where: { id: selfieId } })
}

suite("a manual PENDING holds against automatic promotion", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `mphold-${token}`, name: "Manual pending hold" } })
    for (const [id, role] of [[attesterId, "ADMIN"], [officer, "CREDIT_OFFICER"], [superAdmin, "SUPER_ADMIN"]] as const) {
      await db.user.create({ data: {
        id, tenantId, email: `${id}@test.invalid`, password: "synthetic", role, active: true, totpEnabled: true, lastTotpCounter: 1,
      } })
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    ctx.session = null
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it.each([false, true])("verifying the last missing core document (held: %s)", async (held) => {
    const { clientId } = await seedRestorableClient()
    await db.clientDocument.update({ where: { id: `PAYSLIP_${clientId}` }, data: { verified: false, verifiedAt: null } })
    await holdIf(held, clientId)
    expect((await verifyDoc(clientId, `PAYSLIP_${clientId}`)).status).toBe(200)
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  it.each([false, true])("verifying an unrelated OTHER document (held: %s)", async (held) => {
    const { clientId } = await seedRestorableClient()
    await holdIf(held, clientId)
    const otherId = `other_${clientId}`
    await db.clientDocument.create({ data: { id: otherId, tenantId, clientId, docType: "OTHER", fileUrl: "", fileName: "misc.pdf", verified: false, contentSha256: C } })
    expect((await verifyDoc(clientId, otherId)).status).toBe(200)
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  it.each([false, true])("re-verifying an already-verified core document (held: %s)", async (held) => {
    const { clientId } = await seedRestorableClient()
    await holdIf(held, clientId)
    expect((await verifyDoc(clientId, `PAYSLIP_${clientId}`)).status).toBe(200)
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  it.each([false, true])("refusing a pending replacement ID (held: %s)", async (held) => {
    const { clientId } = await seedRestorableClient([{ sha: B, verified: false, on: 1 }])
    await holdIf(held, clientId)
    const refused = await verifyDoc(clientId, `id_extra0_${clientId}`, { verified: false, rejectReason: "Synthetic: not this client" })
    expect(refused.status).toBe(200)
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  it.each([false, true])("a super admin deleting a pending replacement ID (held: %s)", async (held) => {
    const { clientId } = await seedRestorableClient([{ sha: B, verified: false, on: 1 }])
    await holdIf(held, clientId)
    ctx.session = { user: { id: superAdmin, email: `${superAdmin}@test.invalid`, role: "SUPER_ADMIN", tenantId } }
    expect((await deleteDocument(json("DELETE"), { params: Promise.resolve({ id: `id_extra0_${clientId}` }) })).status).toBe(200)
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  it.each([false, true])("a passed selfie (held: %s)", async (held) => {
    const { clientId, idCopyId } = await seedClient()
    await holdIf(held, clientId)
    const selfie = await passSelfie(clientId, idCopyId)
    expect(selfie).toMatchObject({ verified: true, extractionStatus: "done" })
    expect(await status(clientId)).toBe(held ? "PENDING" : "VERIFIED")
  })

  // A FAILED in between is no way out: only a recorded VERIFIED ends the hold.
  it("holds through a document refusal (FAILED) and the re-verify after it", async () => {
    const { clientId } = await seedRestorableClient()
    await holdIf(true, clientId)
    const payslipId = `PAYSLIP_${clientId}`
    expect((await verifyDoc(clientId, payslipId, { verified: false, rejectReason: "Synthetic: illegible payslip" })).status).toBe(200)
    expect(await status(clientId)).toBe("FAILED")
    expect((await verifyDoc(clientId, payslipId)).status).toBe(200)
    expect(await status(clientId)).toBe("PENDING")
  })

  it("holds through the client's failed selfie (FAILED) and a passing one after it", async () => {
    const { clientId, idCopyId } = await seedClient()
    await holdIf(true, clientId)
    expect(await passSelfie(clientId, idCopyId, { suffix: "_failed", pass: false })).toMatchObject({ verified: false })
    expect(await status(clientId)).toBe("FAILED")
    // A later createdAt, so the passing attempt is the latest one.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(await passSelfie(clientId, idCopyId, { suffix: "_passed" })).toMatchObject({ verified: true })
    expect(await status(clientId)).toBe("PENDING")
  })

  it("promotes again once Approve KYC has ended the hold", async () => {
    const { clientId } = await seedRestorableClient()
    await holdIf(true, clientId)
    ctx.userId = officer
    expect((await setKycStatus(json("PATCH", { kycStatus: "VERIFIED" }), { params: Promise.resolve({ id: clientId }) })).status).toBe(200)
    // A later automatic demotion, then an automatic path that would promote.
    await db.client.update({ where: { id: clientId }, data: { kycStatus: "PENDING", kycVerifiedAt: null, kycVerifiedById: null, kycVerificationMethod: null } })
    const otherId = `other_${clientId}`
    await db.clientDocument.create({ data: { id: otherId, tenantId, clientId, docType: "OTHER", fileUrl: "", fileName: "misc.pdf", verified: false, contentSha256: C } })
    expect((await verifyDoc(clientId, otherId)).status).toBe(200)
    expect(await status(clientId)).toBe("VERIFIED")
  })
})
