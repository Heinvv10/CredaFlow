/**
 * Real-Postgres proof of POST /api/clients/[id]/kyc-rederive, the hint's
 * "Re-verify ID": it re-derives the stored KYC status from the evidence on
 * file and never attests a document. Under the client evidence lock it refuses
 * (409) unless the named ID copy is still verified, not deleted, unrefused and
 * the newest verified copy, and unless the evidence derives VERIFIED.
 *
 * The verify route is called for real to refuse a copy in "another tab".
 * Auth is stubbed to name the acting officer; tenancy runs through
 * runWithTenant as the real context does.
 *
 *   RUN_KYC_REDERIVE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/kyc-rederive.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const ctx = vi.hoisted(() => ({ userId: "", tenantId: "" }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
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
    getDefaultTenantId: async () => ctx.tenantId,
  }
})

import { POST as rederive } from "@/app/api/clients/[id]/kyc-rederive/route"
import { PATCH as verify } from "@/app/api/clients/[id]/documents/[docId]/verify/route"
import { requireApiRole } from "@/lib/auth-guards"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import { ATTESTED_AT, B, day, rederiveFixture } from "@/lib/kyc/kyc-rederive.integration-fixture"

const RUN = process.env.RUN_KYC_REDERIVE_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_rederive_${token}`
ctx.tenantId = tenantId
const attesterId = `attester_${token}`
const officer1 = `officer1_${token}`
const officer2 = `officer2_${token}`
const { seedClient, seedRestorableClient, seedPassedSelfie } = rederiveFixture(db, { tenantId, token, attesterId, label: "rederive" })

const post = (clientId: string, idDocumentId: string, as = officer1) => {
  ctx.userId = as
  return rederive(new NextRequest("http://localhost/", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idDocumentId }),
  }), { params: Promise.resolve({ id: clientId }) })
}
const refuse = (clientId: string, docId: string) => {
  ctx.userId = officer2
  return verify(new NextRequest("http://localhost/", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ verified: false, rejectReason: "Synthetic: photo page is not this client" }),
  }), { params: Promise.resolve({ id: clientId, docId }) })
}
const stored = (clientId: string) => db.client.findUniqueOrThrow({ where: { id: clientId } })
const rederivedAudits = (clientId: string) =>
  db.auditLog.findMany({ where: { tenantId, entityId: clientId, action: "KYC_STATUS_REDERIVED" } })

suite("KYC re-derive (Re-verify ID)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `rederive-${token}`, name: "Re-derive" } })
    for (const [id, role] of [[attesterId, "ADMIN"], [officer1, "CREDIT_OFFICER"], [officer2, "CREDIT_OFFICER"]] as const) {
      await db.user.create({ data: {
        id, tenantId, email: `${id}@test.invalid`, password: "synthetic", role, active: true, totpEnabled: true, lastTotpCounter: 1,
      } })
    }
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("re-derives VERIFIED from the evidence, attesting nothing, and audits it", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    const res = await post(clientId, idCopyId)

    expect(requireApiRole).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kycStatus: "VERIFIED" })
    // The copy's own verification is untouched.
    expect(await db.clientDocument.findUniqueOrThrow({ where: { id: idCopyId } }))
      .toMatchObject({ verified: true, verifiedAt: day(0), verifiedById: null })
    // Provenance is the evidence's (the in-person attestation), not the officer's.
    expect(await stored(clientId)).toMatchObject({
      kycStatus: "VERIFIED", kycVerifiedAt: ATTESTED_AT, kycVerifiedById: attesterId, kycVerificationMethod: "PHYSICAL",
    })
    const audits = await rederivedAudits(clientId)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ userId: officer1, entity: "Client" })
    expect(audits[0].oldValue).toMatchObject({ clientKyc: { kycStatus: "PENDING" } })
    expect(audits[0].newValue).toMatchObject({ clientKyc: { kycStatus: "VERIFIED" }, idDocumentId: idCopyId })
  })

  it("refuses a stale click after another officer refused that copy, leaving KYC unverified", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    expect((await refuse(clientId, idCopyId)).status).toBe(200)

    const res = await post(clientId, idCopyId)

    expect(res.status).toBe(409)
    expect(await db.clientDocument.findUniqueOrThrow({ where: { id: idCopyId } }))
      .toMatchObject({ verified: false, verificationRejectedById: officer2 })
    expect((await stored(clientId)).kycStatus).toBe("FAILED")
    expect(await rederivedAudits(clientId)).toHaveLength(0)
  })

  it("refuses a copy that is no longer the newest verified one, though the evidence holds", async () => {
    // The attestation rests on the newer copy, so only the target check refuses.
    const { clientId, idCopyId } = await seedRestorableClient([{ sha: B, verified: true, on: 1 }], 0)
    const res = await post(clientId, idCopyId)

    expect(res.status).toBe(409)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect((await post(clientId, `id_extra0_${clientId}`)).status).toBe(200)
  })

  // The re-derive still refuses one (defence in depth), but since 20261016120000
  // the database cannot hold a verified copy that carries a refusal marker.
  it("never meets a verified copy that carries a refusal marker", async () => {
    const { idCopyId } = await seedRestorableClient()
    await expect(db.clientDocument.update({ where: { id: idCopyId }, data: { verificationRejectedAt: new Date() } }))
      .rejects.toThrow("ClientDocument_verified_not_refused_check")
  })

  it("refuses a deleted copy", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    await db.clientDocument.update({ where: { id: idCopyId }, data: { deletedAt: new Date() } })

    expect((await post(clientId, idCopyId)).status).toBe(409)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
  })

  it("refuses while the evidence does not derive VERIFIED (a replacement awaits review)", async () => {
    const { clientId, idCopyId } = await seedRestorableClient([{ sha: B, verified: false, on: 1 }])
    const res = await post(clientId, idCopyId)

    expect(res.status).toBe(409)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect(await rederivedAudits(clientId)).toHaveLength(0)
  })

  it("re-derives a selfie-backed client as BIOMETRIC, no verifier, stamped when the selfie passed", async () => {
    const { clientId, idCopyId, subject } = await seedClient()
    const passedAt = new Date("2026-07-12T08:30:00.000Z")
    await seedPassedSelfie(clientId, idCopyId, subject, passedAt)

    const res = await post(clientId, idCopyId)

    expect(res.status).toBe(200)
    // The provenance is the passed selfie's, never the acting officer's.
    expect(await stored(clientId)).toMatchObject({
      kycStatus: "VERIFIED", kycVerificationMethod: "BIOMETRIC", kycVerifiedById: null, kycVerifiedAt: passedAt,
    })
    const audits = await rederivedAudits(clientId)
    expect(audits).toHaveLength(1)
    expect(audits[0].newValue).toMatchObject({
      clientKyc: { kycStatus: "VERIFIED", kycVerificationMethod: "BIOMETRIC", kycVerifiedById: null, kycVerifiedAt: passedAt.toISOString() },
    })
  })

  it.each(["VERIFIED", "FAILED", "EXPIRED"] as const)(
    "refuses when the stored status is %s, though the copy is current and the evidence derives VERIFIED",
    async (status) => {
      const { clientId, idCopyId } = await seedRestorableClient()
      await db.client.update({ where: { id: clientId }, data: status === "VERIFIED"
        ? { kycStatus: status, kycVerifiedAt: ATTESTED_AT, kycVerifiedById: attesterId, kycVerificationMethod: "PHYSICAL" }
        : { kycStatus: status } })
      // Only the stored status stands in the way: the evidence still derives VERIFIED.
      const client = await stored(clientId)
      const composite = await readCompositeKycState(db as unknown as CompositeKycReader, {
        tenantId, clientId, subject: client, existing: client, preserveVerifiedProvenance: true,
      })
      expect(composite.state.kycStatus).toBe("VERIFIED")

      const res = await post(clientId, idCopyId)

      expect(res.status).toBe(409)
      // The ID copy check passed; the refusal is the evidence/status one.
      expect(await res.json()).toMatchObject({ reason: "evidence_does_not_hold" })
      expect((await stored(clientId)).kycStatus).toBe(status)
      expect(await rederivedAudits(clientId)).toHaveLength(0)
    },
  )

  it("is a 404 for a copy of another client", async () => {
    const { clientId } = await seedRestorableClient()
    const other = await seedRestorableClient()
    expect((await post(clientId, other.idCopyId)).status).toBe(404)
  })
})
