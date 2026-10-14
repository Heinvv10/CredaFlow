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
  reasonOf, row, seedClient, stubVlm, sweep, type Fixture,
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

  it("stands when the adverse verdict was recorded before the attestation (staff could see it)", async () => {
    const f = await seed()
    const a = await attempt(f, 1_000)
    stubVlm(different())
    expect(reasonOf(await lateAnswer(f, a))).not.toBeNull()
    await pause(10)
    expect((await inPerson(f.clientId)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("is not touched by a stale answer about a superseded ID copy", async () => {
    const f = await seed()
    const a = await attempt(f, STALE_MS)
    await sweep(f)
    await addVerifiedIdCopy(f, "newer", "b".repeat(64))
    expect((await inPerson(f.clientId)).status).toBe(200)
    await pause(10)
    stubVlm(different())
    // The worker was handed the older copy, which is no longer the current one.
    const after = await lateAnswer(f, a, f.idCopyId)
    expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
    expect((await audits(a.selfieId)).some(isLateAudit)).toBe(false)
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
