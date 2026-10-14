/**
 * Real-Postgres proof that operator staff reach a lender's borrower data only
 * through that lender's active support grant (lib/operator/), on a real
 * borrower route (GET/PUT /api/clients/[id]) with the real guards
 * (requireApiRole, withTenantContext), and that every grant and use is audited.
 *
 * Stubbed: the NextAuth session (operator sign-in is the console's, W1) and
 * the request headers the guards read. Everything else is real.
 *
 *   RUN_TENANT_ISOLATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/operator/support-access.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// The request as proxy.ts hands it on: tenant slug, method and request id stamped.
const mocks = vi.hoisted(() => ({ auth: vi.fn(), request: { current: {} as Record<string, string> } }))
vi.mock("@/lib/auth", () => ({ auth: () => mocks.auth() }))
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(mocks.request.current),
}))

import { randomUUID } from "node:crypto"
import { GET, PUT } from "@/app/api/clients/[id]/route"
import { POST as postMessage } from "@/app/api/clients/[id]/messages/route"
import { REQUEST_ID_HEADER, REQUEST_METHOD_HEADER } from "@/lib/proxy/operator-read-only"
import { grantSupportAccess, revokeSupportAccess, SupportGrantRefusal } from "./support-grants"
import { createIsolationFixture, dropIsolationFixture, type IsolationFixture, type Lender } from "../tenant-isolation.integration-fixture"

const suite = process.env.RUN_TENANT_ISOLATION_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const DAY_MS = 86_400_000

let f: IsolationFixture | undefined
const fx = () => {
  if (!f) throw new Error("fixture missing")
  return f
}

const operatorSession = (totpVerified = true) => ({
  user: { id: fx().operatorUserId, email: `support-${fx().token}@iso-it.invalid`, role: "OPERATOR_SUPPORT", tenantId: null, totpVerified },
})
const adminOf = (l: Lender, totpVerified = true) => ({
  id: l.adminId, email: `admin-${fx().token}@iso-it.invalid`, role: "ADMIN" as const, tenantId: l.tenantId, totpVerified,
})

/** Calls a client route as the operator, on lender `host`'s staff host. */
async function asOperator(host: Lender, clientId: string, method: "GET" | "PUT" | "POST" = "GET") {
  const headers = {
    host: "localhost", "x-tenant-slug": host.slug,
    [REQUEST_METHOD_HEADER]: method, [REQUEST_ID_HEADER]: randomUUID(),
  }
  mocks.request.current = headers
  const path = method === "POST" ? `/api/clients/${clientId}/messages` : `/api/clients/${clientId}`
  const body = method === "PUT"
    ? { firstName: "Mutated" }
    : { text: "Synthetic support note", channel: "EMAIL", operationId: randomUUID() }
  const req = new NextRequest(`http://localhost${path}`, {
    method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  })
  const ctx = { params: Promise.resolve({ id: clientId }) }
  if (method === "GET") return GET(req, ctx)
  return method === "PUT" ? PUT(req, ctx) : postMessage(req, ctx)
}

const auditRows = (action: string) =>
  db.auditLog.findMany({ where: { userId: fx().operatorUserId, action }, orderBy: { createdAt: "asc" } })
const lastRefusal = async () => (await auditRows("SUPPORT_ACCESS_REFUSED")).at(-1)?.newValue as { reason?: string } | undefined

suite("operator support access — grant-gated, read-only, audited", () => {
  let grantId = ""

  beforeAll(async () => {
    f = await createIsolationFixture(db)
  }, 60_000)

  afterAll(async () => {
    await dropIsolationFixture(db, f)
    await db.$disconnect()
  })

  beforeEach(() => {
    mocks.auth.mockResolvedValue(operatorSession())
  })

  it("refuses an operator user with no grant on a borrower route, and audits the refusal", async () => {
    const res = await asOperator(fx().a, fx().a.clientId)
    expect(res.status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "no_active_grant" })
    expect(await auditRows("SUPPORT_ACCESS_USED")).toEqual([])
  })

  it("allows the operator user in, read-only, once the lender's admin grants access; grant and use are audited", async () => {
    const grant = await grantSupportAccess({
      tenantId: fx().a.tenantId, actor: adminOf(fx().a), operatorUserId: fx().operatorUserId,
      expiresAt: new Date(Date.now() + DAY_MS), reason: "Ticket 1: statement question",
    })
    grantId = grant.id
    const granted = await db.auditLog.findMany({ where: { action: "SUPPORT_ACCESS_GRANTED", entityId: grant.id } })
    expect(granted).toHaveLength(1)
    expect(granted[0]).toMatchObject({ tenantId: fx().a.tenantId, userId: fx().a.adminId })

    const res = await asOperator(fx().a, fx().a.clientId)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(fx().a.clientId)
    // One request, one use: requireApiRole and withTenantContext both check
    // the grant, but the use is recorded once.
    const used = await auditRows("SUPPORT_ACCESS_USED")
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ tenantId: fx().a.tenantId, entityId: grant.id })
  })

  it("refuses every write with an active grant, even on a READONLY-floor route, and audits it", async () => {
    // POST /api/clients/[id]/messages admits READONLY by product decision:
    // only the method tells a support read from a write.
    const before = await db.message.count({ where: { tenantId: fx().a.tenantId } })
    const res = await asOperator(fx().a, fx().a.clientId, "POST")
    expect(res.status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "write_refused" })
    expect(await db.message.count({ where: { tenantId: fx().a.tenantId } })).toBe(before)
    expect(await auditRows("SUPPORT_ACCESS_USED")).toHaveLength(1)
  })

  it("a grant from lender A opens nothing at lender B", async () => {
    expect((await asOperator(fx().b, fx().b.clientId)).status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "no_active_grant" })
  })

  it("a grant is read-only: a write route stays refused", async () => {
    expect((await asOperator(fx().a, fx().a.clientId, "PUT")).status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "write_refused" })
    expect((await db.client.findUniqueOrThrow({ where: { id: fx().a.clientId } })).firstName).toBe("Synthetic")
  })

  it("refuses a session whose sign-in verified no TOTP code, even with a grant", async () => {
    mocks.auth.mockResolvedValue(operatorSession(false))
    expect((await asOperator(fx().a, fx().a.clientId)).status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "totp_required" })
  })

  it("refuses once the lender revokes the grant; the revocation is audited and final", async () => {
    await revokeSupportAccess({ tenantId: fx().a.tenantId, actor: adminOf(fx().a), grantId })
    expect(await db.auditLog.count({ where: { action: "SUPPORT_ACCESS_REVOKED", entityId: grantId } })).toBe(1)
    expect((await asOperator(fx().a, fx().a.clientId)).status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "no_active_grant" })
    await expect(revokeSupportAccess({ tenantId: fx().a.tenantId, actor: adminOf(fx().a), grantId }))
      .rejects.toBeInstanceOf(SupportGrantRefusal)
  })

  it("refuses an expired grant", async () => {
    // A grant that ran its 7 days out: written with the insert guard off,
    // since the guard (rightly) refuses to create one already expired.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.$executeRawUnsafe(
        `INSERT INTO "TenantSupportGrant" ("id", "tenantId", "operatorUserId", "grantedById", "reason", "createdAt", "expiresAt")
         VALUES ($1, $2, $3, $4, 'expired', now() - interval '8 days', now() - interval '1 day')`,
        `expired-${fx().token}`, fx().a.tenantId, fx().operatorUserId, fx().a.adminId,
      ),
    ])
    expect((await asOperator(fx().a, fx().a.clientId)).status).toBe(403)
    expect(await lastRefusal()).toMatchObject({ reason: "no_active_grant" })
  })

  it("refuses, and audits, a window the database's clock puts past 7 days", async () => {
    // The application clock a day ahead of the database: 6.9 days by the app
    // is 7.9 days by the database, which the CHECK refuses. That must come back
    // as the same audited bad_window refusal, not an unaudited 500.
    const appNow = new Date(Date.now() + DAY_MS)
    await expect(grantSupportAccess({
      tenantId: fx().a.tenantId, actor: adminOf(fx().a), operatorUserId: fx().operatorUserId,
      expiresAt: new Date(appNow.getTime() + 6.9 * DAY_MS), reason: "Ticket 3", now: appNow,
    })).rejects.toMatchObject({ reason: "bad_window" })
    const refusals = await db.auditLog.findMany({
      where: { tenantId: fx().a.tenantId, action: "SUPPORT_ACCESS_GRANT_REFUSED" }, orderBy: { createdAt: "desc" }, take: 1,
    })
    expect(refusals[0]?.newValue).toMatchObject({ reason: "bad_window", by: "database" })
  })

  it("puts a tenant created without an operator under the root operator (seed, bootstrap, provisioning)", async () => {
    const slug = `iso-it-root-${fx().token}`
    const created = await db.tenant.create({ data: { slug, name: "Root default IT" } })
    try {
      const root = await db.operator.findUniqueOrThrow({ where: { slug: "credaflow" } })
      expect(created.operatorId).toBe(root.id)
    } finally {
      await db.tenant.delete({ where: { id: created.id } })
    }
  })

  it("refuses grants outside the rules, in the helper and in the database", async () => {
    const base = { tenantId: fx().a.tenantId, operatorUserId: fx().operatorUserId, reason: "Ticket 2" }
    const soon = new Date(Date.now() + DAY_MS)
    const cases: Array<[Parameters<typeof grantSupportAccess>[0], string]> = [
      [{ ...base, actor: adminOf(fx().a), expiresAt: new Date(Date.now() + 8 * DAY_MS) }, "bad_window"],
      [{ ...base, actor: { ...adminOf(fx().a), role: "LOAN_ADMIN" }, expiresAt: soon }, "not_lender_admin"],
      [{ ...base, actor: adminOf(fx().b), expiresAt: soon }, "not_lender_admin"],
      [{ ...base, actor: adminOf(fx().a, false), expiresAt: soon }, "totp_required"],
      [{ ...base, actor: adminOf(fx().a), operatorUserId: fx().a.adminId, expiresAt: soon }, "operator_user_invalid"],
    ]
    for (const [input, reason] of cases) {
      await expect(grantSupportAccess(input)).rejects.toMatchObject({ reason })
    }
    // The database holds the window and the binding even for a writer that skips the helper.
    await expect(db.$executeRawUnsafe(
      `INSERT INTO "TenantSupportGrant" ("id", "tenantId", "operatorUserId", "grantedById", "reason", "expiresAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'direct', now() + interval '8 days')`,
      fx().a.tenantId, fx().operatorUserId, fx().a.adminId,
    )).rejects.toThrow(/TenantSupportGrant_window_check/)
    // Lender B moves to another operator: this operator's staff can no longer be granted into it.
    await db.tenant.update({ where: { id: fx().b.tenantId }, data: { operatorId: fx().otherOperatorId } })
    await expect(db.$executeRawUnsafe(
      `INSERT INTO "TenantSupportGrant" ("id", "tenantId", "operatorUserId", "grantedById", "reason", "expiresAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'direct', now() + interval '1 day')`,
      fx().b.tenantId, fx().operatorUserId, fx().b.adminId,
    )).rejects.toThrow(/operator that runs this tenant/)
  })
})
