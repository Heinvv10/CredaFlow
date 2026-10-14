/**
 * Real-Postgres proof that a portal client's deal documents follow their
 * CURRENT authority over the borrowing entity (review finding M1). On a
 * booked deal (relationships may change once a deal is booked: trigger
 * EntityRelationship_fixed_on_open_deal), a director who resigns loses the
 * agreement but keeps their own suretyship while they stand surety; a surety
 * released from the suretyship loses it. Each refused read is 404 and writes
 * no DocumentAccessLog row; a signature attempt is 404 too.
 *
 * Only the session is stubbed. Routes, tenant resolution (by host), feature
 * flag, storage, triggers and the access-log writer are real.
 *
 *   RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/portal-signer-authority.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type DealDocumentKind, type EntityRole } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { cancelDeal } from "./deal-cancel"
import { cleanupBookedContractFixture, createBookedContractFixture, type BookedContractFixture } from "./portal-contract.integration-fixture"

type SessionUser = { id: string; email: string; role: string; tenantId: string }
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { GET as documentRoute } from "@/app/api/portal/asset-finance/deal-signers/[signerId]/document/route"
import { POST as signRoute } from "@/app/api/portal/asset-finance/deal-signers/[signerId]/sign/route"

const RUN = process.env.RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookedContractFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_PORTAL_CONTRACT_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const asClient = (id: string) => setSession({ id, email: `${id}@authority-it.test`, role: "CLIENT", tenantId: fx.tenantId })
const signer = (clientId: string, document: DealDocumentKind) =>
  database().dealSigner.findFirstOrThrow({ where: { dealId: fx.dealId, clientId, document } })
const url = (signerId: string, action: "document" | "sign") => `http://${fx.host}/api/portal/asset-finance/deal-signers/${signerId}/${action}`
const read = (signerId: string) =>
  documentRoute(new NextRequest(url(signerId, "document"), { headers: { host: fx.host } }), { params: Promise.resolve({ signerId }) })
const sign = (signerId: string, documentSha256: string | null) =>
  signRoute(new NextRequest(url(signerId, "sign"), {
    method: "POST",
    headers: { host: fx.host, "content-type": "application/json" },
    body: JSON.stringify({ signature: "TEST Former Signatory", documentSha256 }),
  }), { params: Promise.resolve({ signerId }) })
const end = (clientId: string, role: EntityRole) =>
  database().entityRelationship.updateMany({ where: { tenantId: fx.tenantId, entityId: fx.evidenced, clientId, role }, data: { active: false } })
const accessRows = (documentId: string) => database().documentAccessLog.count({ where: { documentId } })

suite.sequential("portal deal-signer authority follows the live relationship (real Postgres)", () => {
  beforeAll(async () => {
    fx = await createBookedContractFixture(database(), t, setSession)
    // Deal B of the same entity is still CONTRACTED, and an open deal fixes the
    // entity's people (EntityRelationship_fixed_on_open_deal): cancel it.
    const cancelled = await runWithTenant(fx.tenantId, () =>
      cancelDeal({ tenantId: fx.tenantId, userId: fx.adminA }, fx.dealB, "Synthetic: frees the entity's people"))
    expect(cancelled).toMatchObject({ kind: "cancelled" })
  }, 180_000)

  afterAll(async () => {
    if (!db) return
    await cleanupBookedContractFixture(db, fx)
    await db.$disconnect()
  })

  it("while authorised, the director reads the agreement and each surety their own suretyship", async () => {
    asClient(fx.director)
    expect((await read((await signer(fx.director, "AGREEMENT")).id)).status).toBe(200)
    asClient(fx.suretyA)
    expect((await read((await signer(fx.suretyA, "SURETYSHIP")).id)).status).toBe(200)
  })

  it("a director who resigns loses the agreement (404, unlogged) but keeps the suretyship they still stand", async () => {
    await end(fx.director, "DIRECTOR")
    const agreement = await signer(fx.director, "AGREEMENT")
    const before = await accessRows(agreement.id)
    asClient(fx.director)
    expect((await read(agreement.id)).status).toBe(404)
    expect(await accessRows(agreement.id)).toBe(before)
    expect((await sign(agreement.id, agreement.documentSha256)).status).toBe(404)
    expect((await read((await signer(fx.director, "SURETYSHIP")).id)).status).toBe(200)
  })

  it("a released surety loses their suretyship (404, unlogged)", async () => {
    await end(fx.suretyA, "SURETY")
    const own = await signer(fx.suretyA, "SURETYSHIP")
    const before = await accessRows(own.id)
    asClient(fx.suretyA)
    expect((await read(own.id)).status).toBe(404)
    expect(await accessRows(own.id)).toBe(before)
    // suretyB is untouched.
    asClient(fx.suretyB)
    expect((await read((await signer(fx.suretyB, "SURETYSHIP")).id)).status).toBe(200)
  })
})
