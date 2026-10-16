/**
 * Real-Postgres proof that "Re-verify ID" respects a staff member's deliberate
 * manual PENDING (PATCH /api/clients/[id]): the hint's predicate is false and
 * POST /api/clients/[id]/kyc-rederive refuses (409) while it is the client's
 * latest status change. Once the status has left PENDING, a later fall back to
 * PENDING by the client deleting a replacement ID is restorable again.
 *
 * The manual override, the verify route and the document delete run for real.
 * Auth is stubbed to name the actor; tenancy runs through runWithTenant as the
 * real context does.
 *
 *   RUN_KYC_REDERIVE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/kyc-rederive-manual-pending.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const ctx = vi.hoisted(() => ({ userId: "", tenantId: "", session: null as null | { user: Record<string, unknown> } }))
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
import { POST as rederive } from "@/app/api/clients/[id]/kyc-rederive/route"
import { PATCH as verify } from "@/app/api/clients/[id]/documents/[docId]/verify/route"
import { DELETE as deleteDocument } from "@/app/api/documents/[id]/route"
import { readCompositeKycState, type CompositeKycReader } from "@/lib/kyc/document-state"
import {
  readKycBeforeIdUpload,
  reprojectKycAfterIdUpload,
  type IdUploadProjectionTransaction,
} from "@/lib/kyc/id-upload-projection.server"
import { B, rederiveFixture } from "@/lib/kyc/kyc-rederive.integration-fixture"
import { manualPendingStands } from "@/lib/kyc/manual-pending.server"
import { verificationRestorable } from "@/lib/kyc/verification-restorable"

const RUN = process.env.RUN_KYC_REDERIVE_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_manualpend_${token}`
ctx.tenantId = tenantId
const attesterId = `attester_mp_${token}`
const officer = `officer_mp_${token}`
const { seedRestorableClient } = rederiveFixture(db, { tenantId, token, attesterId, label: "manualpend" })

const json = (method: string, body?: unknown) => new NextRequest("http://localhost/", {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const asOfficer = () => { ctx.userId = officer }
const manualPending = (clientId: string) => {
  asOfficer()
  return setKycStatus(json("PATCH", { kycStatus: "PENDING" }), { params: Promise.resolve({ id: clientId }) })
}
const post = (clientId: string, idDocumentId: string) => {
  asOfficer()
  return rederive(json("POST", { idDocumentId }), { params: Promise.resolve({ id: clientId }) })
}
const stored = (clientId: string) => db.client.findUniqueOrThrow({ where: { id: clientId } })

/** What the client page computes for the hint. */
async function hintShown(clientId: string): Promise<boolean> {
  const client = await stored(clientId)
  const composite = await readCompositeKycState(db as unknown as CompositeKycReader, {
    tenantId, clientId, subject: client, existing: client, preserveVerifiedProvenance: true,
  })
  return verificationRestorable(client.kycStatus, composite, {
    manualPendingStands: await manualPendingStands(db, { tenantId, clientId }),
  })
}

suite("KYC re-derive after a manual PENDING", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `manualpend-${token}`, name: "Manual pending" } })
    for (const [id, role] of [[attesterId, "ADMIN"], [officer, "CREDIT_OFFICER"]] as const) {
      await db.user.create({ data: {
        id, tenantId, email: `${id}@test.invalid`, password: "synthetic", role, active: true, totpEnabled: true, lastTotpCounter: 1,
      } })
    }
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("hides the hint and refuses re-derive while a deliberate manual PENDING is the latest change", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    expect(await hintShown(clientId)).toBe(true)

    expect((await manualPending(clientId)).status).toBe(200)

    expect(await hintShown(clientId)).toBe(false)
    const res = await post(clientId, idCopyId)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ reason: "manual_pending_stands" })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect(await db.auditLog.count({ where: { tenantId, entityId: clientId, action: "KYC_STATUS_REDERIVED" } })).toBe(0)
  })

  it("is restorable again after the status left PENDING and a client's delete brought it back", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    const payslipId = `PAYSLIP_${clientId}`
    await db.clientDocument.update({ where: { id: payslipId }, data: { verified: false, verifiedAt: null } })
    expect((await manualPending(clientId)).status).toBe(200)

    // Staff verify the payslip: the rollup leaves PENDING, audited on the document.
    asOfficer()
    expect((await verify(json("PATCH", { verified: true }), { params: Promise.resolve({ id: clientId, docId: payslipId }) })).status).toBe(200)
    expect((await stored(clientId)).kycStatus).toBe("VERIFIED")

    // The client uploads a different ID copy (held PENDING), then deletes it.
    const replacementId = `replacement_${clientId}`
    const email = (await stored(clientId)).email as string
    await db.$transaction(async (tx) => {
      const kycTx = tx as unknown as IdUploadProjectionTransaction
      const before = await readKycBeforeIdUpload(kycTx, { tenantId, clientId })
      await tx.clientDocument.create({ data: {
        id: replacementId, tenantId, clientId, docType: "ID_COPY", fileUrl: "", fileName: "id.pdf", verified: false, contentSha256: B,
      } })
      await reprojectKycAfterIdUpload(kycTx, { tenantId, clientId, documentId: replacementId, before, actor: { type: "client", email } })
    })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    ctx.session = { user: { id: clientId, email, role: "CLIENT", tenantId } }
    expect((await deleteDocument(json("DELETE"), { params: Promise.resolve({ id: replacementId }) })).status).toBe(200)
    ctx.session = null
    expect((await stored(clientId)).kycStatus).toBe("PENDING")

    expect(await hintShown(clientId)).toBe(true)
    const res = await post(clientId, idCopyId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kycStatus: "VERIFIED" })
  })
})
