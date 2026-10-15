/**
 * Real-database proof, through the real pipeline, that an in-person
 * attestation lapses when an adverse face verdict is recorded after it, or a
 * selfie submitted after it ends with an unknown outcome (migration
 * 20261014120000_in_person_lapse_on_adverse_verdict), and that it stands when
 * staff could see the verdict or the answer is stale.
 *
 *   RUN_SELFIE_SWEEPER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/in-person-lapse-pipeline.integration.test.ts
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

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

import { POST as inPersonPOST } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import {
  STALE_MS, addVerifiedIdCopy, attempt, audits, db, different, isLateAudit, kycStatus, lateAnswer, layers,
  reasonOf, reply, row, seedClient, silhouette, stubVlm, sweep, type Fixture,
} from "@/lib/kyc/selfie-sweeper.test-helpers"

const RUN = process.env.RUN_SELFIE_SWEEPER_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function seed(): Promise<Fixture> {
  const fixture = await seedClient()
  ctx.tenantId = fixture.tenantId
  ctx.adminId = fixture.adminId
  return fixture
}

const inPerson = (clientId: string) => inPersonPOST(new Request("http://localhost/", {
  method: "POST",
  body: JSON.stringify({ method: "IN_PERSON_BRANCH", note: "Synthetic applicant attended a branch and matched the ID photo." }),
}) as never, { params: Promise.resolve({ id: clientId }) })

const verified = async (clientId: string) => ({ status: await kycStatus(clientId), ...(await layers(clientId)) })
const VERIFIED_IN_BOTH = { status: "VERIFIED", app: true, sql: true, failed: false }

suite("in-person attestation against a later face verdict", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  // The two stamps come from different app hosts in production. Both are read
  // from the database clock, so a host clock that is an hour off cannot order
  // them wrongly.
  it("orders the stamps by the database clock when the verdict's host clock runs an hour behind", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    expect((await inPerson(f.clientId)).status).toBe(200)
    await pause(10)
    stubVlm(different())
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 3_600_000 })
    try {
      await lateAnswer(f, a)
    } finally {
      vi.useRealTimers()
    }
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
  })

  it("orders the stamps by the database clock when the attestation's host clock runs an hour ahead", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3_600_000 })
    try {
      expect((await inPerson(f.clientId)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
    await pause(10)
    stubVlm(different())
    await lateAnswer(f, a)
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
  })

  it("lapses when an adverse verdict is recorded after the attestation, and can be re-attested", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)

    await pause(10)
    stubVlm(different())
    const after = await lateAnswer(f, a)
    expect(reasonOf(after)).not.toBe("biometric_outcome_not_recorded")
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    const late = (await audits(a.selfieId)).find(isLateAudit)
    expect(late?.oldValue).toMatchObject({ clientKyc: { kycStatus: "VERIFIED" } })
    expect(late?.newValue).toMatchObject({ clientKyc: { kycStatus: "FAILED" } })
    expect(late?.action).toBe("KYC_REJECTED")

    // Staff can now see the verdict: a fresh attestation completed after it stands.
    await pause(10)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("is not rescued by a deliberately benign-failing retake after the adverse verdict", async () => {
    const f = await seed()
    expect((await inPerson(f.clientId)).status).toBe(200)
    await pause(10)
    const first = await attempt(f, 1_000)
    stubVlm(different())
    expect(reasonOf(await lateAnswer(f, first))).not.toBeNull()
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")

    // The retake fails for a benign reason: neither photo is judged.
    const retake = await attempt(f, 500)
    const unjudged: Record<string, unknown> = reply({ faceDetected: false })
    for (const key of ["idPhotoKind", "idPhotoIsRealPhotograph", "idPhotoFaceDetected", "selfieIsRealPhotograph"]) delete unjudged[key]
    stubVlm(unjudged)
    expect(reasonOf(await lateAnswer(f, retake))).toBe("extraction_incomplete")

    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    // Only a fresh attestation completed after the verdict restores it.
    await pause(10)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("stands when the adverse verdict was recorded before the attestation (staff could see it)", async () => {
    const f = await seed()
    const a = await attempt(f, 1_000)
    stubVlm(different())
    expect(reasonOf(await lateAnswer(f, a))).not.toBeNull()
    await pause(10)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("records a late answer about a superseded ID copy without lapsing an attestation bound to the newer copy", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    await addVerifiedIdCopy(f, "newer", "b".repeat(64))
    expect((await inPerson(f.clientId)).status).toBe(200)
    await pause(10)
    stubVlm(different())
    // The worker was handed the older copy, which is no longer the current one.
    const after = await lateAnswer(f, a, f.idCopyId)
    expect(reasonOf(after)).toBe("subject_identity_changed")
    expect((after.biometricResult as Record<string, unknown>).idDocumentId).toBe(f.idCopyId)
    expect((await audits(a.selfieId)).some(isLateAudit)).toBe(true)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  // Dropping that answer would let it fail to count if the newer copy is later
  // rejected and the older one, which the attestation names, becomes current.
  it("lapses an attestation on the older copy once the newer copy is rejected and the recorded verdict names the older", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    expect((await inPerson(f.clientId)).status).toBe(200)
    const newer = await addVerifiedIdCopy(f, "newer", "b".repeat(64))
    await pause(10)
    stubVlm(different())
    const after = await lateAnswer(f, a, f.idCopyId)
    expect((after.biometricResult as Record<string, unknown>).idDocumentId).toBe(f.idCopyId)

    await db.clientDocument.update({
      where: { id: newer },
      data: { verified: false, verifiedAt: null, verificationNote: "Rejected: synthetic", verificationRejectedAt: new Date(), verificationRejectedById: "officer-synthetic" },
    })
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
  })

  // The swept marker: a late answer about ANOTHER copy replaces the swept
  // reason with the real one, but the selfie was never compared with the
  // attested copy, so the attestation must stay lapsed whatever arrives.
  it("stays lapsed after a late adverse answer about another, still unverified, ID copy", async () => {
    const f = await seed()
    expect((await inPerson(f.clientId)).status).toBe(200)
    // The next selfie is compared with the client's CURRENT copy, an unverified upload.
    const other = await addVerifiedIdCopy(f, "unverified", "c".repeat(64), false)
    const a = await attempt(f, STALE_MS, { createdAt: new Date(Date.now() + 1_000) })
    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")

    await pause(10)
    stubVlm(different())
    const after = await lateAnswer(f, a, other)
    expect((after.biometricResult as Record<string, unknown>).idDocumentId).toBe(other)
    expect(reasonOf(after)).not.toBe("biometric_outcome_not_recorded")
    expect((after.biometricResult as Record<string, unknown>).sweptAt).toEqual(expect.any(String))

    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    // Recovery: a fresh attestation completed after the lost attempt.
    await pause(1_100)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("stays lapsed after a late adverse answer about another ID copy that staff then reject", async () => {
    const f = await seed()
    expect((await inPerson(f.clientId)).status).toBe(200)
    const other = await addVerifiedIdCopy(f, "other", "b".repeat(64))
    const a = await attempt(f, STALE_MS, { createdAt: new Date(Date.now() + 1_000) })
    await sweep(f)
    await pause(10)
    stubVlm(different())
    await lateAnswer(f, a, other)

    // Rejecting the other copy makes the attested copy the newest verified again.
    await db.clientDocument.update({
      where: { id: other },
      data: { verified: false, verifiedAt: null, verificationNote: "Rejected: synthetic", verificationRejectedAt: new Date(), verificationRejectedById: "officer-synthetic" },
    })
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
  })

  it("refuses a second identical attestation while the first still stands, even after a late answer moved the key", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    await addVerifiedIdCopy(f, "newer", "b".repeat(64))
    expect((await inPerson(f.clientId)).status).toBe(200)
    await pause(10)
    stubVlm(different())
    // Recorded on the latest attempt, so the idempotency key is no longer the same...
    await lateAnswer(f, a, f.idCopyId)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
    // ...but the attestation stands, so a duplicate is refused.
    expect((await inPerson(f.clientId)).status).toBe(409)
    expect(await db.complianceRecord.count({ where: { referenceId: f.clientId, type: "KYC_EXCEPTION" } })).toBe(1)
  })

  it("keeps an ID-portrait refusal the worker gave about a superseded copy", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    // The current copy moves on (an unverified upload), so the worker's answer about the older one is recorded as superseded.
    await addVerifiedIdCopy(f, "unverified", "c".repeat(64), false)
    stubVlm(silhouette())
    const after = await lateAnswer(f, a, f.idCopyId)
    expect(reasonOf(after)).toBe("subject_identity_changed")
    expect((after.biometricResult as Record<string, unknown>).workerFailureReason).toBe("id_document_portrait_invalid")
    // The route is closed over the copy that has no photograph.
    expect((await inPerson(f.clientId)).status).toBe(422)
  })

  it("still refuses a late PASS about a superseded ID copy", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    await addVerifiedIdCopy(f, "newer", "b".repeat(64))
    stubVlm(reply())
    const after = await lateAnswer(f, a, f.idCopyId)
    expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
    expect((await audits(a.selfieId)).some(isLateAudit)).toBe(false)
  })

  // A portal client can delete an unverified attempt that is still being
  // checked. Neither the sweeper nor the worker writes a deleted row, so it
  // never gets a reason or a marker, and it stops blocking the route.
  it("lapses when a selfie submitted after the attestation is deleted while still processing", async () => {
    const f = await seed()
    expect((await inPerson(f.clientId)).status).toBe(200)
    const a = await attempt(f, 1_000, { createdAt: new Date(Date.now() + 1_000) })
    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")

    await db.clientDocument.update({ where: { id: a.selfieId }, data: { deletedAt: new Date(), deletedByType: "client" } })
    // The sweeper skips deleted rows, so nothing will ever answer for it.
    expect(await sweep(f)).toEqual({ swept: 0, failed: 0 })
    expect((await row(a.selfieId)).extractionStatus).toBe("processing")

    expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    // Recovery: a fresh attestation completed after the lost attempt.
    await pause(1_100)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("stands when the selfie was deleted while processing BEFORE the attestation (staff attested knowing)", async () => {
    const f = await seed()
    const a = await attempt(f, 1_000)
    await db.clientDocument.update({ where: { id: a.selfieId }, data: { deletedAt: new Date(), deletedByType: "client" } })
    await pause(10)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("lapses when a selfie submitted after the attestation is swept with an unknown outcome", async () => {
    const f = await seed()
    expect((await inPerson(f.clientId)).status).toBe(200)
    // Submitted after the attestation; its worker then died.
    const a = await attempt(f, STALE_MS, { createdAt: new Date(Date.now() + 1_000) })
    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })

    expect(reasonOf(await row(a.selfieId))).toBe("biometric_outcome_not_recorded")
    expect(await kycStatus(f.clientId)).toBe("FAILED")
    expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
    const log = (await audits(a.selfieId)).find((l) => l.userEmail === "system@selfie-sweeper")
    expect(log?.action).toBe("KYC_REJECTED")
    expect(log?.newValue).toMatchObject({ clientKyc: { kycStatus: "FAILED" } })

    // Recovery: a new attestation completed after the lost attempt.
    await pause(1_100)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("stands when the attempt was swept before the attestation (staff attested knowing it was lost)", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
    expect((await row(a.selfieId)).extractionStatus).toBe("failed")
  })
})
