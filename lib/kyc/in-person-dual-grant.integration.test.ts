/**
 * Real-database proof for the dual-approval in-person grant
 * (app/api/clients/[id]/kyc-override-requests/[requestId]): it shares the
 * direct route's idempotency key and the database clock, so re-attesting by
 * dual approval after a lapse works instead of hitting P2002, and mixed
 * direct/dual re-grants do too.
 *
 *   RUN_SELFIE_SWEEPER_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/in-person-dual-grant.integration.test.ts
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

import { NextRequest } from "next/server"
import { POST as inPersonPOST } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import { PUT as decidePUT } from "@/app/api/clients/[id]/kyc-override-requests/[requestId]/route"
import {
  STALE_MS, attempt, db, different, kycStatus, lateAnswer, layers, seedClient, stubVlm, sweep, type Fixture,
} from "@/lib/kyc/selfie-sweeper.test-helpers"

const RUN = process.env.RUN_SELFIE_SWEEPER_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const NOTE = "Synthetic applicant attended a branch and matched the ID photo."
let approvers = 0

type Seeded = Fixture & { approverId: string }

/** A client plus a SECOND admin, as dual approval needs two different seniors. */
async function seed(): Promise<Seeded> {
  const fixture = await seedClient()
  approvers += 1
  const approver = await db.user.create({
    data: {
      email: `dual-approver-${approvers}-${fixture.tenantId}@test.invalid`, password: "x", role: "ADMIN",
      tenantId: fixture.tenantId, active: true, totpEnabled: true, lastTotpCounter: 1,
    },
  })
  ctx.tenantId = fixture.tenantId
  ctx.adminId = fixture.adminId
  return { ...fixture, approverId: approver.id }
}

/** Direct grants need second approval OFF; dual-control requests need it ON. */
const setSecondApprover = (f: Seeded, on: boolean) => db.tenantConfig.upsert({
  where: { tenantId: f.tenantId },
  create: { tenantId: f.tenantId, kycOverrideSecondApprover: on },
  update: { kycOverrideSecondApprover: on },
})

const direct = async (f: Seeded) => {
  await setSecondApprover(f, false)
  ctx.adminId = f.adminId
  return inPersonPOST(new Request("http://localhost/", {
    method: "POST", body: JSON.stringify({ method: "IN_PERSON_BRANCH", note: NOTE }),
  }) as never, { params: Promise.resolve({ id: f.clientId }) })
}

/** The requester (admin A) asks, the other senior (admin B) approves. */
async function dual(f: Seeded, approverHostAheadMs = 0) {
  await setSecondApprover(f, true)
  const requestedAt = new Date()
  const request = await db.kycOverrideRequest.create({
    data: {
      tenantId: f.tenantId, clientId: f.clientId, kind: "IN_PERSON", payload: { method: "IN_PERSON_BRANCH", note: NOTE },
      requestedById: f.adminId, requestedWithTotp: true, requestedAt,
      expiresAt: new Date(requestedAt.getTime() + 7 * 86_400_000),
    },
  })
  ctx.adminId = f.approverId
  // Only the approving host's clock is skewed (the request row is checked
  // against the database clock, so it is created on a true clock).
  if (approverHostAheadMs) vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + approverHostAheadMs })
  try {
    return await decidePUT(new NextRequest("http://localhost/", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "APPROVED", reason: "Synthetic second approval after reviewing the evidence." }),
    }), { params: Promise.resolve({ id: f.clientId, requestId: request.id }) })
  } finally {
    vi.useRealTimers()
  }
}

const verified = async (clientId: string) => ({ status: await kycStatus(clientId), ...(await layers(clientId)) })
const VERIFIED_IN_BOTH = { status: "VERIFIED", app: true, sql: true, failed: false }

/** A swept attempt from before any attestation, so the attestation is not lapsed by it. */
async function sweptBefore(f: Seeded) {
  const a = await attempt(f, STALE_MS)
  await sweep(f)
  return a
}

async function lateAdverse(f: Seeded, a: { selfieId: string; generation: string }) {
  await pause(10)
  stubVlm(different())
  await lateAnswer(f, a)
  expect(await kycStatus(f.clientId)).not.toBe("VERIFIED")
  expect(await layers(f.clientId)).toMatchObject({ app: false, sql: false })
}

suite("dual-approval in-person grant", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  it("grants by dual approval, lapses on a late adverse verdict, and re-grants by dual approval", async () => {
    const f = await seed()
    const a = await sweptBefore(f)
    expect((await dual(f)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)

    await lateAdverse(f, a)
    // Before the shared key: P2002 -> 500, with the client locked out.
    await pause(10)
    expect((await dual(f)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("grants directly, lapses, and re-grants by dual approval", async () => {
    const f = await seed()
    const a = await sweptBefore(f)
    expect((await direct(f)).status).toBe(200)
    await lateAdverse(f, a)
    await pause(10)
    expect((await dual(f)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("grants by dual approval, lapses, and re-grants directly", async () => {
    const f = await seed()
    const a = await sweptBefore(f)
    expect((await dual(f)).status).toBe(200)
    await lateAdverse(f, a)
    await pause(10)
    expect((await direct(f)).status).toBe(200)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  it("answers 409, not 500, when the same circumstances were already attested by the other route", async () => {
    const f = await seed()
    await sweptBefore(f)
    expect((await direct(f)).status).toBe(200)
    const again = await dual(f)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ code: "verification_exists" })
    // The refused request stays PENDING and nothing was granted twice.
    expect(await db.kycOverrideRequest.count({ where: { clientId: f.clientId, status: "PENDING" } })).toBe(1)
    expect(await verified(f.clientId)).toEqual(VERIFIED_IN_BOTH)
  })

  // The attestation and the verdict are stamped by different app hosts in
  // production; both come from the database clock, so a skewed host clock
  // cannot order them wrongly.
  it("orders the stamps by the database clock when the approving host runs an hour ahead", async () => {
    const f = await seed()
    const a = await sweptBefore(f)
    expect((await dual(f, 3_600_000)).status).toBe(200)
    await lateAdverse(f, a)
  })
})
