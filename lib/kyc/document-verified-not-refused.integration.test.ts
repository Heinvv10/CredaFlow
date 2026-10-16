/**
 * Real-Postgres proof of migration 20261016120000_client_document_verified_not_refused:
 * a ClientDocument row is never verified and refused at once
 * (ClientDocument_verified_not_refused_check). A direct write that would make
 * one is rejected by name; the only writer of the refusal markers, the staff
 * verify route, still accepts and refuses, clearing the other side each time.
 *
 * Auth is stubbed to name the acting officer; tenancy runs through
 * runWithTenant as the real context does.
 *
 *   RUN_DOC_VERIFIED_NOT_REFUSED_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/document-verified-not-refused.integration.test.ts
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

import { PATCH as verify } from "@/app/api/clients/[id]/documents/[docId]/verify/route"

const RUN = process.env.RUN_DOC_VERIFIED_NOT_REFUSED_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `t_vnr_${token}`
ctx.tenantId = tenantId
const officerId = `officer_vnr_${token}`
const CONSTRAINT = "ClientDocument_verified_not_refused_check"
let sequence = 0

async function seedClient() {
  sequence += 1
  const clientId = `c_vnr_${sequence}_${token}`
  await db.client.create({ data: {
    id: clientId, tenantId, reference: `CLI-VNR-${sequence}-${token}`, idNumber: `VNR-${sequence}-${token}`,
    firstName: "Synthetic", lastName: "Refusal", email: `vnr-${sequence}-${token}@test.invalid`, phone: "+27820000068",
  } })
  return clientId
}

/** A proof-of-address copy: no KYC trigger needs more evidence than the row itself. */
async function seedDocument(clientId: string, state: { verified: boolean; refused: boolean }) {
  const id = `doc_vnr_${randomUUID().slice(0, 8)}_${token}`
  await db.clientDocument.create({ data: {
    id, tenantId, clientId, docType: "PROOF_OF_ADDRESS", fileUrl: "", fileName: "address.pdf",
    contentSha256: "d".repeat(64),
    verified: state.verified, verifiedAt: state.verified ? new Date() : null, verifiedById: state.verified ? officerId : null,
    verificationNote: state.refused ? "Synthetic: unreadable" : null,
    verificationRejectedAt: state.refused ? new Date() : null, verificationRejectedById: state.refused ? officerId : null,
  } })
  return id
}

const patch = (clientId: string, docId: string, body: Record<string, unknown>) => {
  ctx.userId = officerId
  return verify(new NextRequest("http://localhost/", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: clientId, docId }) })
}

const row = (id: string) => db.clientDocument.findUniqueOrThrow({
  where: { id }, select: { verified: true, verifiedById: true, verificationRejectedAt: true, verificationRejectedById: true },
})

suite("ClientDocument: verified and refused are exclusive", () => {
  let clientId = ""

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `vnr-${token}`, name: "Verified not refused" } })
    await db.user.create({ data: {
      id: officerId, tenantId, email: `${officerId}@test.invalid`, password: "synthetic",
      role: "CREDIT_OFFICER", active: true, totpEnabled: true, lastTotpCounter: 1,
    } })
    clientId = await seedClient()
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("is in the catalog as a CHECK on ClientDocument", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT conrelid::regclass::text AS relname FROM pg_constraint WHERE contype = 'c' AND conname = $1`, CONSTRAINT,
    )
    expect(rows).toEqual([{ relname: `"ClientDocument"` }])
  })

  it.each([
    ["verificationRejectedAt", `now(), NULL`],
    ["verificationRejectedById", `NULL, '${"x".repeat(8)}'`],
  ])("rejects a direct insert that is verified and carries %s", async (_marker, markers) => {
    const write = db.$executeRawUnsafe(
      `INSERT INTO "ClientDocument" ("id","tenantId","clientId","docType","fileUrl","fileName","verified","verificationRejectedAt","verificationRejectedById")
       VALUES ($1, $2, $3, 'PROOF_OF_ADDRESS', '', 'address.pdf', true, ${markers})`,
      `doc_vnr_insert_${randomUUID().slice(0, 8)}`, tenantId, clientId,
    )
    await expect(write).rejects.toThrow(CONSTRAINT)
  })

  it("rejects a direct update that refuses a verified row without clearing verified", async () => {
    const id = await seedDocument(clientId, { verified: true, refused: false })
    await expect(db.$executeRawUnsafe(
      `UPDATE "ClientDocument" SET "verificationRejectedAt" = now() WHERE "id" = $1`, id,
    )).rejects.toThrow(CONSTRAINT)
    expect((await row(id)).verified).toBe(true)
  })

  it("rejects a direct update that verifies a refused row without clearing the refusal", async () => {
    const id = await seedDocument(clientId, { verified: false, refused: true })
    await expect(db.clientDocument.update({ where: { id }, data: { verified: true } })).rejects.toThrow(CONSTRAINT)
    expect((await row(id)).verified).toBe(false)
  })

  it("lets the verify route refuse a verified copy, clearing verified", async () => {
    const id = await seedDocument(clientId, { verified: true, refused: false })
    const res = await patch(clientId, id, { verified: false, rejectReason: "Synthetic: address does not match" })
    expect(res.status).toBe(200)
    expect(await row(id)).toMatchObject({
      verified: false, verifiedById: null, verificationRejectedById: officerId, verificationRejectedAt: expect.any(Date),
    })
  })

  it("lets the verify route accept a refused copy, clearing the refusal", async () => {
    const id = await seedDocument(clientId, { verified: false, refused: true })
    const res = await patch(clientId, id, { verified: true })
    expect(res.status).toBe(200)
    expect(await row(id)).toEqual({
      verified: true, verifiedById: officerId, verificationRejectedAt: null, verificationRejectedById: null,
    })
  })
})
