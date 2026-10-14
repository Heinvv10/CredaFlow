/**
 * Real-database proof for the stuck-selfie sweeper and for a worker's late
 * answer after its attempt was swept. Only the VLM HTTP call, the face model's
 * comparison, file storage and session/tenant resolution are stubbed; the
 * composite-KYC triggers, the revoke trigger and both gates run for real.
 *
 *   RUN_SELFIE_SWEEPER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/selfie-sweeper.integration.test.ts
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

import { SELFIE_PROCESSING_TIMEOUT_MS } from "@/lib/kyc/selfie-sweeper.server"
import { POST as inPersonPOST } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import { POST as exceptionPOST } from "@/app/api/clients/[id]/kyc-exception/route"
import {
  STALE_MS, attempt, audits, db, different, isLateAudit, kycStatus, lateAnswer, layers, reasonOf,
  reply, row, seedClient, silhouette, stubVlm, sweep, type Fixture,
} from "@/lib/kyc/selfie-sweeper.test-helpers"

const RUN = process.env.RUN_SELFIE_SWEEPER_IT === "1"
const suite = RUN ? describe.sequential : describe.skip

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

suite("stuck selfie sweeper", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("fails a stale processing attempt as an adverse, non-verifying result, and audits it", async () => {
    const f = await seed()
    const stuck = await attempt(f, STALE_MS)

    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
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

    // The audit action matches the resulting status: FAILED is a rejection.
    const log = (await audits(stuck.selfieId)).find((a) => a.userEmail === "system@selfie-sweeper")
    expect(log).toMatchObject({ action: "KYC_REJECTED", entity: "ClientDocument", tenantId: f.tenantId })
    expect(log?.newValue).toMatchObject({ document: { extractionStatus: "failed", latestSelfie: true }, clientKyc: { kycStatus: "FAILED" } })

    expect(await sweep(f)).toEqual({ swept: 0, failed: 0 })
  })

  it("leaves an attempt inside the timeout alone", async () => {
    const f = await seed()
    const live = await attempt(f, SELFIE_PROCESSING_TIMEOUT_MS - 60_000)
    expect(await sweep(f)).toEqual({ swept: 0, failed: 0 })
    expect((await row(live.selfieId)).extractionStatus).toBe("processing")
  })

  it("does not re-project the client over a swept attempt that a newer selfie superseded", async () => {
    const f = await seed()
    const older = await attempt(f, STALE_MS + 60_000)
    const newer = await attempt(f, 60_000)
    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
    expect((await row(older.selfieId)).extractionStatus).toBe("failed")
    expect((await row(newer.selfieId)).extractionStatus).toBe("processing")
    expect((await audits(older.selfieId)).find((a) => a.userEmail === "system@selfie-sweeper")?.newValue)
      .toMatchObject({ document: { latestSelfie: false } })
  })

  it("sweeps a staff-rejected processing attempt too, keeping the note and the rejecter", async () => {
    const f = await seed()
    const rejected = await attempt(f, STALE_MS, {
      data: {
        verificationNote: "Rejected: the selfie is not the applicant",
        verificationRejectedAt: new Date(), verificationRejectedById: f.adminId,
      },
    })
    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
    const after = await row(rejected.selfieId)
    expect(after).toMatchObject({
      extractionStatus: "failed", verified: false,
      verificationNote: "Rejected: the selfie is not the applicant", verificationRejectedById: f.adminId,
    })
    expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
    // No longer blocks the in-person route, which is the point of sweeping it.
    expect((await inPerson(f.clientId)).status).toBe(200)
  })

  it("audits an older attempt swept behind a newer selfie as a document-level fact, not a client rejection", async () => {
    const f = await seed()
    const older = await attempt(f, STALE_MS + 60_000)
    await attempt(f, 60_000)
    await sweep(f)
    const log = (await audits(older.selfieId)).find((a) => a.userEmail === "system@selfie-sweeper")
    expect(log?.action).toBe("BIOMETRIC_ATTEMPT_SWEPT")
    expect(log?.newValue).toMatchObject({ document: { latestSelfie: false } })
  })

  it("keeps sweeping the newer rows when the oldest one throws, and reports the failure", async () => {
    const f = await seed()
    const poisoned = await attempt(f, STALE_MS + 120_000)
    const healthy = await attempt(f, STALE_MS)
    // Test-only trigger on this throwaway database, dropped in the finally.
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION public.synthetic_poison_selfie() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic poisoned row'; END $$`)
    await db.$executeRawUnsafe(
      `CREATE TRIGGER synthetic_poison BEFORE UPDATE ON "ClientDocument" FOR EACH ROW WHEN (OLD."id" = '${poisoned.selfieId}') EXECUTE FUNCTION public.synthetic_poison_selfie()`)
    try {
      expect(await sweep(f)).toEqual({ swept: 1, failed: 1 })
      expect((await row(poisoned.selfieId)).extractionStatus).toBe("processing")
      expect((await row(healthy.selfieId)).extractionStatus).toBe("failed")
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER synthetic_poison ON "ClientDocument"`)
      await db.$executeRawUnsafe(`DROP FUNCTION public.synthetic_poison_selfie()`)
    }
    expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
  })

  describe("a worker's late answer after the sweep", () => {
    it("records an adverse answer for the current attempt and audits it", async () => {
      const f = await seed()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(after.extractionStatus).toBe("failed")
      expect(after.verified).toBe(false)
      expect(reasonOf(after)).not.toBe("biometric_outcome_not_recorded")
      expect((after.biometricResult as Record<string, unknown>).swept).toBeUndefined()
      const late = (await audits(a.selfieId)).find(isLateAudit)
      expect(late).toMatchObject({ action: "KYC_REJECTED" })
      expect(await kycStatus(f.clientId)).toBe("FAILED")
    })

    it("refuses a late answer on a row that carried a staff note before the sweep (a manual decision supersedes it)", async () => {
      const f = await seed()
      const a = await attempt(f, STALE_MS, { data: { verificationNote: "Flagged by staff: possible spoof" } })
      expect(await sweep(f)).toEqual({ swept: 1, failed: 0 })
      expect((await row(a.selfieId)).verificationNote).toBe("Flagged by staff: possible spoof")
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
      expect(after.verificationNote).toBe("Flagged by staff: possible spoof")
      expect((await audits(a.selfieId)).some(isLateAudit)).toBe(false)
    })

    it("ignores a late pass: a swept attempt never verifies", async () => {
      const f = await seed()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      stubVlm(reply())
      const after = await lateAnswer(f, a)
      expect(after).toMatchObject({ extractionStatus: "failed", verified: false, biometricVerifiedAt: null })
      expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
      expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
    })

    it("ignores a stale answer for an attempt a newer selfie superseded", async () => {
      const f = await seed()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      await attempt(f, 1_000)
      stubVlm(different())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).toBe("biometric_outcome_not_recorded")
      expect((await audits(a.selfieId)).some(isLateAudit)).toBe(false)
    })

    it("revokes a client verified in person when the late answer is a refused ID portrait", async () => {
      const f = await seed()
      const a = await attempt(f, STALE_MS)
      await sweep(f)
      expect((await inPerson(f.clientId)).status).toBe(200)
      expect(await kycStatus(f.clientId)).toBe("VERIFIED")

      stubVlm(silhouette())
      const after = await lateAnswer(f, a)
      expect(reasonOf(after)).toBe("id_document_portrait_invalid")
      expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
      expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
      const late = (await audits(a.selfieId)).find(isLateAudit)
      expect(late?.oldValue).toMatchObject({ clientKyc: { kycStatus: "VERIFIED" } })
      expect(late?.newValue).toMatchObject({ clientKyc: { kycStatus: expect.not.stringMatching(/^VERIFIED$/) } })
    })
  })
})
