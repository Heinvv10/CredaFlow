/**
 * Real-Postgres proof of the lender API: a key only ever reaches its own
 * lender's rows (through the real routes, the real tenant-scope extension and
 * the real database), scopes and revocation hold, and the webhook outbox
 * triggers, fan-out, signing and retry work end to end.
 *
 *   RUN_API_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/lender-api/lender-api.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { createApiTenant, deleteApiTenant, issueKey, type ApiTenant } from "./lender-api.integration-fixture"
import { GET as listClients } from "@/app/api/v1/clients/route"
import { GET as getClient } from "@/app/api/v1/clients/[id]/route"
import { GET as listApplications, POST as createApplication } from "@/app/api/v1/applications/route"
import { GET as getApplication } from "@/app/api/v1/applications/[id]/route"
import { GET as listLoans } from "@/app/api/v1/loans/route"
import { GET as getLoan } from "@/app/api/v1/loans/[id]/route"
import { GET as getSchedule } from "@/app/api/v1/loans/[id]/schedule/route"
import { GET as listPayments } from "@/app/api/v1/payments/route"
import { GET as getPayment } from "@/app/api/v1/payments/[id]/route"
import { revokeApiKey } from "./key-admin"
import { encodeCursor } from "./pagination"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const post = vi.hoisted(() => ({ calls: [] as Array<{ url: string; body: string; headers: Record<string, string> }>, status: 200 }))
vi.mock("./webhooks/post", () => ({
  postWebhook: async (url: string, body: string, headers: Record<string, string>) => {
    post.calls.push({ url, body, headers })
    const ok = post.status >= 200 && post.status < 300
    return { ok, status: post.status, error: ok ? null : `HTTP ${post.status}` }
  },
}))
import { createWebhookEndpoint, disableWebhookEndpoint } from "./webhooks/endpoints"
import { runWebhookDeliveries } from "./webhooks/dispatch"
import { verifyWebhookSignature } from "./webhooks/signing"

const RUN = process.env.RUN_API_IT === "1"
const suite = RUN ? describe : describe.skip

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>
const call = async (handler: Handler | ((req: Request) => Promise<Response>), key: string, path: string, opts: { id?: string; init?: RequestInit; headers?: Record<string, string> } = {}) => {
  const req = new Request(`http://localhost${path}`, { ...opts.init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...opts.headers } })
  const res = await (handler as Handler)(req, { params: Promise.resolve({ id: opts.id ?? "" }) })
  return { status: res.status, body: await res.json() }
}

suite("lender API (real database)", () => {
  const db = new PrismaClient()
  let A: ApiTenant, B: ApiTenant
  let keyA: string, keyB: string, piiKeyA: string, narrowKeyA: string

  beforeAll(async () => {
    vi.stubEnv("WEBHOOK_SECRET_KEY", randomBytes(32).toString("base64"))
    A = await createApiTenant(db, "a")
    B = await createApiTenant(db, "b")
    const all = ["clients:read", "applications:read", "applications:write", "loans:read", "payments:read"] as const
    keyA = (await issueKey(db, A, [...all])).key
    keyB = (await issueKey(db, B, [...all])).key
    piiKeyA = (await issueKey(db, A, ["clients:read", "pii:read"])).key
    narrowKeyA = (await issueKey(db, A, ["clients:read"])).key
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    for (const t of [A, B]) if (t) await deleteApiTenant(db, t)
    await db.$disconnect()
  })

  it("key A lists only lender A's rows on every list route", async () => {
    _resetRateLimitStore()
    const lists: Array<[(req: Request) => Promise<Response>, string, string]> = [
      [listClients, "/api/v1/clients", A.clientId],
      [listApplications, "/api/v1/applications", A.applicationId],
      [listLoans, "/api/v1/loans", A.loanId],
      [listPayments, "/api/v1/payments", A.paymentId],
    ]
    for (const [handler, path, ownId] of lists) {
      const { status, body } = await call(handler, keyA, path)
      expect(status, path).toBe(200)
      const ids = body.data.map((r: { id: string }) => r.id)
      expect(ids, path).toContain(ownId)
      expect(ids.filter((id: string) => id.includes("_b_") || [B.clientId, B.applicationId, B.loanId, B.paymentId].includes(id)), path).toEqual([])
    }
  })

  it("key A cannot read lender B's client, application, loan, schedule or payment by id (404)", async () => {
    const reads: Array<[Handler, string, string]> = [
      [getClient, "/api/v1/clients", B.clientId],
      [getApplication, "/api/v1/applications", B.applicationId],
      [getLoan, "/api/v1/loans", B.loanId],
      [getSchedule, "/api/v1/loans", B.loanId],
      [getPayment, "/api/v1/payments", B.paymentId],
    ]
    for (const [handler, base, id] of reads) {
      const { status } = await call(handler, keyA, `${base}/${id}`, { id })
      expect(status, `${base}/${id}`).toBe(404)
    }
    expect((await call(getLoan, keyB, `/api/v1/loans/${B.loanId}`, { id: B.loanId })).status).toBe(200)
  })

  it("the tenant comes from the key: a header naming lender B changes nothing", async () => {
    const { body } = await call(listClients, keyA, "/api/v1/clients", { headers: { "x-tenant-slug": B.slug, "x-tenant-id": B.tenantId } })
    expect(body.data.map((c: { id: string }) => c.id)).not.toContain(B.clientId)
    const filtered = await call(listLoans, keyA, `/api/v1/loans?clientId=${B.clientId}`)
    expect(filtered.body.data).toEqual([])
  })

  it("pages through its own rows; a cursor naming lender B's row only filters A's rows by time", async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const q: string = cursor ? `&cursor=${cursor}` : ""
      const { status, body } = await call(listClients, keyA, `/api/v1/clients?limit=1${q}`)
      expect(status).toBe(200)
      seen.push(...body.data.map((c: { id: string }) => c.id))
      cursor = body.nextCursor
    } while (cursor && seen.length < 10)
    expect(seen.sort()).toEqual([A.clientId, A.spareClientId].sort())

    const bRow = await db.client.findUniqueOrThrow({ where: { id: B.clientId }, select: { id: true, createdAt: true } })
    const forged = encodeCursor({ id: bRow.id, createdAt: new Date(bRow.createdAt.getTime() + 60_000) })
    const { status, body } = await call(listClients, keyA, `/api/v1/clients?cursor=${forged}`)
    expect(status).toBe(200)
    expect(body.data.map((c: { id: string }) => c.id).sort()).toEqual([A.clientId, A.spareClientId].sort())
  })

  it("refuses an oversized create body (413)", async () => {
    const big = JSON.stringify({ clientId: A.clientId, productId: A.productId, appliedAmountCents: 1, appliedTermDays: 1, purpose: "x".repeat(20_000) })
    expect((await call(createApplication, keyA, "/api/v1/applications", { init: { method: "POST", body: big } })).status).toBe(413)
  })

  it("masks the ID number without pii:read and shows it with", async () => {
    const plain = await call(getClient, keyA, `/api/v1/clients/${A.clientId}`, { id: A.clientId })
    expect(plain.body.idNumberMasked).toBe("*********" + A.idNumber.slice(-4))
    expect(plain.body.idNumber).toBeUndefined()
    expect(plain.body.email).toBeUndefined()
    const pii = await call(getClient, piiKeyA, `/api/v1/clients/${A.clientId}`, { id: A.clientId })
    expect(pii.body.idNumber).toBe(A.idNumber)
  })

  it("enforces scopes and logs every call against the key's lender", async () => {
    expect((await call(listLoans, narrowKeyA, "/api/v1/loans")).status).toBe(403)
    const logs = await db.apiRequestLog.findMany({ where: { tenantId: A.tenantId } })
    expect(logs.length).toBeGreaterThan(5)
    expect(logs.some((l) => l.status === 403 && l.path === "/api/v1/loans")).toBe(true)
    expect(await db.apiRequestLog.count({ where: { tenantId: B.tenantId, path: { startsWith: "/api/v1/clients" } } })).toBe(0)
  })

  it("refuses a revoked key and an expired key", async () => {
    const k = await issueKey(db, A, ["clients:read"])
    expect((await call(listClients, k.key, "/api/v1/clients")).status).toBe(200)
    expect(await revokeApiKey({ tenantId: B.tenantId, actor: { id: B.userId, email: "b@test.invalid" }, keyId: k.id })).toBe("not_found")
    expect(await revokeApiKey({ tenantId: A.tenantId, actor: { id: A.userId, email: "a@test.invalid" }, keyId: k.id })).toBe("revoked")
    expect((await call(listClients, k.key, "/api/v1/clients")).body.error.code).toBe("api_key_revoked")
    expect(await db.auditLog.count({ where: { tenantId: A.tenantId, action: "API_KEY_REVOKED", entityId: k.id } })).toBe(1)
    const expired = await issueKey(db, A, ["clients:read"], { expiresAt: new Date(Date.now() - 1000) })
    expect((await call(listClients, expired.key, "/api/v1/clients")).body.error.code).toBe("api_key_expired")
  })

  it("the database refuses an unknown scope", async () => {
    await expect(issueKey(db, A, ["loans:write" as never])).rejects.toThrow(/ApiKey_scopes_check/)
  })

  describe("webhooks", () => {
    let secret = ""
    let endpointId = ""

    it("creates a draft application for its own client only, emits application.created, and audits", async () => {
      const created = await createWebhookEndpoint(
        { tenantId: A.tenantId, actor: { id: A.userId, email: "a@test.invalid" }, url: "https://hooks.example.com/a", description: null, events: ["application.created", "application.status_changed", "loan.disbursed", "payment.received"] },
        async () => [{ address: "93.184.215.14", family: 4 }],
      )
      if (!created.ok) throw new Error(created.error)
      secret = created.secret
      endpointId = created.endpoint.id

      const body = { clientId: A.spareClientId, productId: A.productId, appliedAmountCents: 200_000, appliedTermDays: 30, purpose: "Synthetic purpose" }
      const res = await call(createApplication, keyA, "/api/v1/applications", { init: { method: "POST", body: JSON.stringify(body) } })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.status).toBe("DRAFT")
      expect(await db.auditLog.count({ where: { tenantId: A.tenantId, action: "APPLICATION_CREATED_VIA_API", entityId: res.body.id } })).toBe(1)
      expect((await call(createApplication, keyA, "/api/v1/applications", { init: { method: "POST", body: JSON.stringify(body) } })).status).toBe(409)
      const foreign = await call(createApplication, keyA, "/api/v1/applications", { init: { method: "POST", body: JSON.stringify({ ...body, clientId: B.spareClientId, productId: B.productId }) } })
      expect(foreign.status).toBe(404)

      await db.loanApplication.update({ where: { id: res.body.id }, data: { status: "CANCELLED" } })
      await db.payment.create({ data: { tenantId: A.tenantId, loanId: A.loanId, amount: 1_000 } })
      // Lender B has no endpoint: its writes leave no outbox rows at all.
      await db.payment.create({ data: { tenantId: B.tenantId, loanId: B.loanId, amount: 1_000 } })
      const types = (await db.webhookEvent.findMany({ where: { tenantId: A.tenantId }, orderBy: { createdAt: "asc" } })).map((e) => e.type)
      expect(types).toEqual(["application.created", "application.status_changed", "payment.received"])
      expect(await db.webhookEvent.count({ where: { tenantId: B.tenantId } })).toBe(0)
    })

    it("delivers each event once, signed with the endpoint secret", async () => {
      post.calls = []
      post.status = 200
      const r = await runWebhookDeliveries({ budgetMs: 10_000 })
      expect(r.succeeded).toBe(3)
      expect(post.calls.map((c) => JSON.parse(c.body).type).sort()).toEqual(["application.created", "application.status_changed", "payment.received"])
      for (const c of post.calls) {
        expect(c.url).toBe("https://hooks.example.com/a")
        expect(verifyWebhookSignature(secret, c.headers["CredaFlow-Signature"], c.body)).toBe(true)
        expect(JSON.parse(c.body).id).toBe(c.headers["CredaFlow-Event-Id"])
      }
      expect(await db.webhookDelivery.count({ where: { endpointId, status: "SUCCEEDED" } })).toBe(3)
      post.calls = []
      await runWebhookDeliveries({ budgetMs: 10_000 })
      expect(post.calls).toEqual([])
    })

    it("retries a failed delivery with backoff, and stops enqueueing once the endpoint is disabled", async () => {
      post.status = 503
      await db.payment.create({ data: { tenantId: A.tenantId, loanId: A.loanId, amount: 2_000 } })
      const before = Date.now()
      const r = await runWebhookDeliveries({ budgetMs: 10_000 })
      expect(r.retrying).toBe(1)
      const pending = await db.webhookDelivery.findFirstOrThrow({ where: { endpointId, status: "PENDING" } })
      expect(pending.attempts).toBe(1)
      expect(pending.lastResponseStatus).toBe(503)
      expect(pending.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(59_000)

      expect(await disableWebhookEndpoint({ tenantId: A.tenantId, actor: { id: A.userId, email: "a@test.invalid" }, endpointId })).toBe("disabled")
      await db.payment.create({ data: { tenantId: A.tenantId, loanId: A.loanId, amount: 3_000 } })
      expect(await db.webhookEvent.count({ where: { tenantId: A.tenantId, dispatchedAt: null } })).toBe(0)
    })
  })
})
