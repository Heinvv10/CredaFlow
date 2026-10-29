/**
 * Real-Postgres proof that "Re-verify ID" respects a staff member's deliberate
 * manual PENDING (PATCH /api/clients/[id]): the hint's predicate is false and
 * POST /api/clients/[id]/kyc-rederive refuses (409) while it is the client's
 * latest status change. Only staff's explicit Approve KYC ends it; after that a
 * fall back to PENDING by the client deleting a replacement ID is restorable
 * again. The borrower's portal checklist reads incomplete while it is held.
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
import { plantAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

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
import { PORTAL_KYC_SNAPSHOT_OPTIONS, readPortalKycDocumentState } from "@/lib/kyc/portal-document-state"
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

/** Whether the borrower's portal checklist reads complete. */
async function portalComplete(clientId: string): Promise<boolean | undefined> {
  const state = await db.$transaction(
    (tx) => readPortalKycDocumentState(tx, { tenantId, clientWhere: { id: clientId } }),
    PORTAL_KYC_SNAPSHOT_OPTIONS,
  )
  return state?.kycChecklist.complete
}

/** A client-uploaded ID copy with other bytes, re-projected as the upload route does. */
async function clientUploadsReplacement(clientId: string, replacementId: string) {
  const email = (await stored(clientId)).email as string
  await db.$transaction(async (tx) => {
    const kycTx = tx as unknown as IdUploadProjectionTransaction
    const before = await readKycBeforeIdUpload(kycTx, { tenantId, clientId })
    await tx.clientDocument.create({ data: {
      id: replacementId, tenantId, clientId, docType: "ID_COPY", fileUrl: "", fileName: "id.pdf", verified: false, contentSha256: B,
    } })
    await reprojectKycAfterIdUpload(kycTx, { tenantId, clientId, documentId: replacementId, before, actor: { type: "client", email } })
  })
  return email
}

async function clientDeletes(clientId: string, email: string, documentId: string) {
  ctx.session = { user: { id: clientId, email, role: "CLIENT", tenantId } }
  const res = await deleteDocument(json("DELETE"), { params: Promise.resolve({ id: documentId }) })
  ctx.session = null
  return res
}

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
    // The evidence would verify, so staff are pointed at Approve KYC.
    expect(await res.json()).toMatchObject({ reason: "manual_pending_stands", error: expect.stringContaining("Approve KYC") })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect(await db.auditLog.count({ where: { tenantId, entityId: clientId, action: "KYC_STATUS_REDERIVED" } })).toBe(0)
  })

  it("does not point staff at Approve KYC when the evidence would not verify", async () => {
    const { clientId, idCopyId } = await seedRestorableClient([{ sha: B, verified: false, on: 1 }])
    expect((await manualPending(clientId)).status).toBe(200)

    const res = await post(clientId, idCopyId)

    expect(res.status).toBe(409)
    const body = await res.json() as { reason: string; error: string }
    expect(body.reason).toBe("manual_pending_stands")
    expect(body.error).not.toContain("Approve KYC")
  })

  it("holds through a staff verify, ends on Approve KYC, then a client's delete is restorable again", async () => {
    const { clientId, idCopyId } = await seedRestorableClient()
    const payslipId = `PAYSLIP_${clientId}`
    await db.clientDocument.update({ where: { id: payslipId }, data: { verified: false, verifiedAt: null } })
    expect((await manualPending(clientId)).status).toBe(200)

    // Verifying the last missing document would roll up to VERIFIED; the hold keeps PENDING.
    asOfficer()
    const verified = await verify(json("PATCH", { verified: true }), { params: Promise.resolve({ id: clientId, docId: payslipId }) })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({ kycStatus: "PENDING" })
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect(await hintShown(clientId)).toBe(false)
    // The borrower sees the stored status too: not complete while held.
    expect(await portalComplete(clientId)).toBe(false)

    // Only the explicit Approve KYC ends it (a Client-entity row recording VERIFIED).
    asOfficer()
    expect((await setKycStatus(json("PATCH", { kycStatus: "VERIFIED" }), { params: Promise.resolve({ id: clientId }) })).status).toBe(200)
    expect((await stored(clientId)).kycStatus).toBe("VERIFIED")
    expect(await manualPendingStands(db, { tenantId, clientId })).toBe(false)
    expect(await portalComplete(clientId)).toBe(true)

    // The client uploads a different ID copy (held PENDING), then deletes it.
    const replacementId = `replacement_${clientId}`
    const email = await clientUploadsReplacement(clientId, replacementId)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")
    expect((await clientDeletes(clientId, email, replacementId)).status).toBe(200)
    expect((await stored(clientId)).kycStatus).toBe("PENDING")

    expect(await hintShown(clientId)).toBe(true)
    const res = await post(clientId, idCopyId)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kycStatus: "VERIFIED" })
  })

  it("keeps the hold through a client's replacement upload and delete", async () => {
    const { clientId } = await seedRestorableClient()
    expect((await manualPending(clientId)).status).toBe(200)
    const replacementId = `replacement_${clientId}`
    const email = await clientUploadsReplacement(clientId, replacementId)
    expect((await clientDeletes(clientId, email, replacementId)).status).toBe(200)

    expect(await manualPendingStands(db, { tenantId, clientId })).toBe(true)
    expect(await hintShown(clientId)).toBe(false)
  })

  it("never leaves VERIFIED when a manual PENDING races a re-derive", async () => {
    for (let round = 0; round < 6; round++) {
      const { clientId, idCopyId } = await seedRestorableClient()
      const [manual, rederived] = await Promise.all([manualPending(clientId), post(clientId, idCopyId)])
      expect(manual.status).toBe(200)
      // Either order serialises on the evidence lock and ends PENDING with the hold standing.
      expect([200, 409]).toContain(rederived.status)
      expect((await stored(clientId)).kycStatus).toBe("PENDING")
      expect(await manualPendingStands(db, { tenantId, clientId })).toBe(true)
    }
  })

  it("keeps the hold when a non-PENDING row shares the manual row's createdAt", async () => {
    const { clientId } = await seedRestorableClient()
    expect((await manualPending(clientId)).status).toBe(200)
    const manual = await db.auditLog.findFirstOrThrow({
      where: { tenantId, entity: "Client", entityId: clientId, action: "KYC_STATUS_CHANGED" }, orderBy: { createdAt: "desc" },
    })
    // Same millisecond, an id that sorts after the manual row's.
    await plantAuditRowsForTest(db, [{
      id: `zzzz_${token}`, tenantId, userId: officer, action: "KYC_APPROVED", entity: "Client", entityId: clientId,
      createdAt: manual.createdAt, newValue: { kycStatus: "VERIFIED", manualOverride: true },
    }])
    expect(await manualPendingStands(db, { tenantId, clientId })).toBe(true)
  })

  it("ignores rows for the same client id in another tenant, and another client's documents", async () => {
    const { clientId } = await seedRestorableClient()
    const { clientId: otherClientId } = await seedRestorableClient()
    expect((await manualPending(clientId)).status).toBe(200)
    const otherTenantId = `t_manualpend_other_${token}`
    await db.tenant.create({ data: { id: otherTenantId, slug: `manualpend-other-${token}`, name: "Other lender" } })
    const later = new Date(Date.now() + 60_000)
    await plantAuditRowsForTest(db, [
      { tenantId: otherTenantId, action: "KYC_APPROVED", entity: "Client", entityId: clientId, createdAt: later, newValue: { kycStatus: "VERIFIED" } },
      { tenantId: null, action: "KYC_APPROVED", entity: "Client", entityId: clientId, createdAt: later, newValue: { kycStatus: "VERIFIED" } },
      { tenantId, action: "DOCUMENT_VERIFIED", entity: "ClientDocument", entityId: `PAYSLIP_${otherClientId}`, createdAt: later, newValue: { clientKyc: { kycStatus: "VERIFIED" } } },
    ])
    expect(await manualPendingStands(db, { tenantId, clientId })).toBe(true)

    // The same row in this tenant does end it.
    await plantAuditRowsForTest(db, [{ tenantId, action: "KYC_APPROVED", entity: "Client", entityId: clientId, createdAt: later, newValue: { kycStatus: "VERIFIED" } }])
    expect(await manualPendingStands(db, { tenantId, clientId })).toBe(false)
  })
})
