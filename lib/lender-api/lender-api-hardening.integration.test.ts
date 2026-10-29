/**
 * Real-Postgres proof of the review round-1 fixes: junk-key floods cannot lock
 * out a valid key or fill ApiRequestLog (B1), the webhook dispatcher is fair
 * across endpoints, pauses a failing one and skips lenders that are not ACTIVE
 * (B5), keys of a demoted creator stop working and free text needs pii:read
 * (S2), and old logs are pruned.
 *
 *   RUN_API_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/lender-api/lender-api-hardening.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { createApiTenant, deleteApiTenant, issueKey, type ApiTenant } from "./lender-api.integration-fixture"
import { GET as listClients } from "@/app/api/v1/clients/route"
import { GET as getApplication } from "@/app/api/v1/applications/[id]/route"
import { generateApiKey } from "./keys"
import { sealSecret } from "@/lib/crypto/secret-box"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const post = vi.hoisted(() => ({ byUrl: new Map<string, number>(), failUrls: new Set<string>() }))
vi.mock("./webhooks/post", () => ({
  postWebhook: async (url: string) => {
    post.byUrl.set(url, (post.byUrl.get(url) ?? 0) + 1)
    const ok = !post.failUrls.has(url)
    return { ok, status: ok ? 200 : 503, error: ok ? null : "HTTP 503", attempted: true }
  },
}))
import { runWebhookDeliveries, PER_ENDPOINT_PER_RUN, PER_TENANT_PER_RUN } from "./webhooks/dispatch"
import { CIRCUIT_BREAKER_FAILURES, resumeWebhookEndpoint } from "./webhooks/circuit-breaker"
import { pruneLenderApiLogs } from "./retention"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"

const RUN = process.env.RUN_API_IT === "1"
const suite = RUN ? describe : describe.skip

const call = async (key: string, path = "/api/v1/clients") => {
  const res = await listClients(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${key}` } }))
  return res.status
}

suite("lender API hardening (real database)", () => {
  const db = new PrismaClient()
  let A: ApiTenant, B: ApiTenant
  const sealKey = randomBytes(32).toString("base64")

  beforeAll(async () => {
    vi.stubEnv("WEBHOOK_SECRET_KEY", sealKey)
    A = await createApiTenant(db, "ha")
    B = await createApiTenant(db, "hb")
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    for (const t of [A, B]) if (t) await deleteApiTenant(db, t)
    await db.$disconnect()
  })

  it("B1: 650 junk-key requests neither lock out a valid key nor write 650 log rows", async () => {
    _resetRateLimitStore()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const valid = await issueKey(db, A, ["clients:read"])
    const since = new Date()
    // Refused throughout: 401, then 429 once the global failed-auth bucket (no known address) is full.
    for (let i = 0; i < 650; i++) expect([401, 429]).toContain(await call(generateApiKey().key))
    expect(await call(valid.key)).toBe(200)
    const unattributed = await db.apiRequestLog.count({ where: { apiKeyId: null, oauthClientId: null, path: { startsWith: "/api/v1/" }, createdAt: { gte: since } } })
    // Only /api/v1 rows: another suite's token-endpoint refusals share this table when the suites run side by side.
    expect(unattributed).toBeLessThanOrEqual(10)
    expect(await db.apiRequestLog.count({ where: { apiKeyId: valid.id } })).toBe(1)
    warn.mockRestore()
  })

  it("S2: a key stops working when its creator is demoted or deactivated; purpose needs pii:read", async () => {
    _resetRateLimitStore()
    const key = await issueKey(db, A, ["clients:read", "applications:read"])
    const pii = await issueKey(db, A, ["applications:read", "pii:read"])
    const read = async (k: string) => {
      const res = await getApplication(new Request(`http://localhost/api/v1/applications/${A.applicationId}`, { headers: { authorization: `Bearer ${k}` } }), { params: Promise.resolve({ id: A.applicationId }) })
      return { status: res.status, body: await res.json() }
    }
    await db.loanApplication.update({ where: { id: A.applicationId }, data: { purpose: "Synthetic school fees for a named child" } })
    expect((await read(key.key)).body).not.toHaveProperty("purpose")
    expect((await read(pii.key)).body.purpose).toBe("Synthetic school fees for a named child")

    await db.user.update({ where: { id: A.userId }, data: { role: "BRANCH_MANAGER" } })
    expect(await call(key.key)).toBe(401)
    await db.user.update({ where: { id: A.userId }, data: { role: "ADMIN", active: false } })
    expect(await call(key.key)).toBe(401)
    await db.user.update({ where: { id: A.userId }, data: { active: true } })
    expect(await call(key.key)).toBe(200)
  })

  describe("B5: dispatcher fairness and circuit breaker", () => {
    const endpoint = async (t: ApiTenant, url: string) => db.webhookEndpoint.create({
      data: { tenantId: t.tenantId, url, events: ["payment.received"], secretSealed: sealSecret("whsec_it", sealKey), secretPrefix: "whsec_it", createdById: t.userId },
    })
    const backlog = async (t: ApiTenant, endpointId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const ev = await db.webhookEvent.create({ data: { tenantId: t.tenantId, type: "payment.received", entityId: `e${i}`, data: {}, dispatchedAt: new Date() } })
        await db.webhookDelivery.create({ data: { tenantId: t.tenantId, endpointId, eventId: ev.id } })
      }
    }

    it("one endpoint's backlog cannot starve another's delivery", async () => {
      const noisy = await endpoint(A, "https://noisy.example.com/hook")
      const quiet = await endpoint(A, "https://quiet.example.com/hook")
      await backlog(A, noisy.id, 60)
      await backlog(A, quiet.id, 1)
      post.byUrl.clear()
      await runWebhookDeliveries({ budgetMs: 20_000 })
      expect(post.byUrl.get("https://quiet.example.com/hook")).toBe(1)
      expect(post.byUrl.get("https://noisy.example.com/hook")).toBeLessThanOrEqual(PER_ENDPOINT_PER_RUN + 1)
      await db.webhookEndpoint.updateMany({ where: { id: { in: [noisy.id, quiet.id] } }, data: { active: false, disabledAt: new Date(), disabledById: A.userId } })
    })

    it("pauses an endpoint after repeated failures, audited, and holds its deliveries until resumed", async () => {
      const failing = await endpoint(A, "https://down.example.com/hook")
      post.failUrls.add("https://down.example.com/hook")
      await backlog(A, failing.id, CIRCUIT_BREAKER_FAILURES + 15)
      post.byUrl.clear()
      // Several runs: each takes at most PER_ENDPOINT_PER_RUN of this endpoint.
      for (let i = 0; i < 3; i++) await runWebhookDeliveries({ budgetMs: 20_000 })
      const paused = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: failing.id } })
      expect(paused.pausedAt).not.toBeNull()
      expect(paused.consecutiveFailures).toBeGreaterThanOrEqual(CIRCUIT_BREAKER_FAILURES)
      expect(post.byUrl.get("https://down.example.com/hook")).toBeLessThanOrEqual(CIRCUIT_BREAKER_FAILURES + 10)
      expect(await db.auditLog.count({ where: { tenantId: A.tenantId, action: "WEBHOOK_ENDPOINT_PAUSED", entityId: failing.id } })).toBe(1)

      // Due again, but paused: not claimed, no attempt spent.
      await db.webhookDelivery.updateMany({ where: { endpointId: failing.id, status: "PENDING" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
      const before = post.byUrl.get("https://down.example.com/hook")
      await runWebhookDeliveries({ budgetMs: 5_000 })
      expect(post.byUrl.get("https://down.example.com/hook")).toBe(before)

      post.failUrls.clear()
      expect(await resumeWebhookEndpoint({ tenantId: A.tenantId, endpointId: failing.id, actor: { id: A.userId, email: "a@test.invalid" } })).toBe("resumed")
      await runWebhookDeliveries({ budgetMs: 20_000 })
      expect(post.byUrl.get("https://down.example.com/hook")!).toBeGreaterThan(before!)
      expect((await db.webhookEndpoint.findUniqueOrThrow({ where: { id: failing.id } })).consecutiveFailures).toBe(0)
      expect(await db.auditLog.count({ where: { tenantId: A.tenantId, action: "WEBHOOK_ENDPOINT_RESUMED" } })).toBe(1)
    })

    // Review round 2 (A): with WEBHOOK_SECRET_KEY missing, 30 pending
    // deliveries paused the endpoint without the receiver ever being contacted.
    it("a local fault (no sealing key) neither counts toward the breaker nor spends attempts", async () => {
      const ep = await endpoint(A, "https://localfault.example.com/hook")
      await backlog(A, ep.id, 30)
      vi.stubEnv("WEBHOOK_SECRET_KEY", "")
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      post.byUrl.clear()
      try {
        for (let i = 0; i < 3; i++) {
          await db.webhookDelivery.updateMany({ where: { endpointId: ep.id, status: "PENDING" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } })
          await runWebhookDeliveries({ budgetMs: 10_000 })
        }
      } finally {
        vi.stubEnv("WEBHOOK_SECRET_KEY", sealKey)
        warn.mockRestore()
      }
      expect(post.byUrl.get("https://localfault.example.com/hook")).toBeUndefined()
      const after = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
      expect(after.pausedAt).toBeNull()
      expect(after.consecutiveFailures).toBe(0)
      const rows = await db.webhookDelivery.findMany({ where: { endpointId: ep.id } })
      expect(rows.every((r) => r.status === "PENDING" && r.attempts === 0)).toBe(true)
      expect(rows.some((r) => r.lastError?.includes("WEBHOOK_SECRET_KEY"))).toBe(true)
      await db.webhookEndpoint.update({ where: { id: ep.id }, data: { active: false, disabledAt: new Date(), disabledById: A.userId } })
    })

    // Review round 2 (C): fairness was per endpoint only; one lender with many
    // endpoints could still take a whole run.
    it("one lender's backlog across many endpoints cannot starve another lender", async () => {
      const eps = await Promise.all([1, 2, 3, 4, 5].map((i) => endpoint(A, `https://many${i}.example.com/hook`)))
      for (const ep of eps) await backlog(A, ep.id, 20)
      const other = await endpoint(B, "https://other-lender.example.com/hook")
      await backlog(B, other.id, 1)
      post.byUrl.clear()
      await runWebhookDeliveries({ budgetMs: 20_000 })
      expect(post.byUrl.get("https://other-lender.example.com/hook")).toBe(1)
      const forA = eps.reduce((n, _ep, i) => n + (post.byUrl.get(`https://many${i + 1}.example.com/hook`) ?? 0), 0)
      expect(forA).toBeLessThanOrEqual(PER_TENANT_PER_RUN + 10)
      await db.webhookEndpoint.updateMany({ where: { id: { in: eps.map((e) => e.id) } }, data: { active: false, disabledAt: new Date(), disabledById: A.userId } })
      await db.webhookEndpoint.update({ where: { id: other.id }, data: { active: false, disabledAt: new Date(), disabledById: B.userId } })
    })

    it("does not deliver for a lender that is not ACTIVE", async () => {
      const ep = await endpoint(B, "https://b.example.com/hook")
      await backlog(B, ep.id, 2)
      await db.tenant.update({ where: { id: B.tenantId }, data: { status: "SUSPENDED" } })
      post.byUrl.clear()
      await runWebhookDeliveries({ budgetMs: 5_000 })
      expect(post.byUrl.get("https://b.example.com/hook")).toBeUndefined()
      await db.tenant.update({ where: { id: B.tenantId }, data: { status: "ACTIVE" } })
      await runWebhookDeliveries({ budgetMs: 5_000 })
      expect(post.byUrl.get("https://b.example.com/hook")).toBe(2)
    })
  })

  describe("U1: the outbox triggers never fail a core write", () => {
    let ep = ""
    beforeAll(async () => {
      ep = (await db.webhookEndpoint.create({
        data: { tenantId: A.tenantId, url: "https://outbox.example.com/hook", events: ["payment.received", "loan.disbursed", "application.created"], secretSealed: sealSecret("whsec_it", sealKey), secretPrefix: "whsec_it", createdById: A.userId },
      })).id
    })
    afterAll(async () => {
      await db.webhookEndpoint.updateMany({ where: { id: ep }, data: { active: false, disabledAt: new Date(), disabledById: A.userId } })
    })
    const events = (type: string, entityId: string) => db.webhookEvent.count({ where: { tenantId: A.tenantId, type, entityId } })

    it("a receipt through applyManualReceipt and a booked loan enqueue their events", async () => {
      const payment = await applyManualReceipt(db as unknown as PaymentDb, { loanId: A.loanId, tenantId: A.tenantId, amount: 1_500, capturedById: A.userId })
      expect(await events("payment.received", payment.payment.id)).toBe(1)
      const app = await db.loanApplication.create({ data: { tenantId: A.tenantId, reference: `APP-U1-${Date.now()}`, clientId: A.spareClientId, productId: A.productId, appliedAmount: 100_000, appliedTermDays: 30 } })
      expect(await events("application.created", app.id)).toBe(1)
      const loan = await db.loan.create({
        data: {
          tenantId: A.tenantId, reference: `LN-U1-${Date.now()}`, applicationId: app.id, clientId: A.spareClientId, productId: A.productId,
          principal: 100_000, totalInterest: 5_000, initiationFee: 0, totalRepayable: 105_000, outstandingPrincipal: 100_000,
          startDate: new Date(), maturityDate: new Date(Date.now() + 30 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE",
        },
      })
      expect(await events("loan.disbursed", loan.id)).toBe(1)
    })

    it("a fault inside the enqueue becomes a warning, and the payment and application writes still commit", async () => {
      await db.$executeRawUnsafe(`ALTER FUNCTION public.webhook_enqueue(text, text, text, jsonb) RENAME TO webhook_enqueue_saved_it`)
      try {
        await db.$executeRawUnsafe(`CREATE FUNCTION public.webhook_enqueue(p_tenant text, p_type text, p_entity text, p_data jsonb)
          RETURNS void LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $f$`)
        const direct = await db.payment.create({ data: { tenantId: A.tenantId, loanId: A.loanId, amount: 1_000 } })
        const viaCode = await applyManualReceipt(db as unknown as PaymentDb, { loanId: A.loanId, tenantId: A.tenantId, amount: 1_000, capturedById: A.userId })
        const app = await db.loanApplication.create({ data: { tenantId: A.tenantId, reference: `APP-U1F-${Date.now()}`, clientId: A.clientId, productId: A.productId, appliedAmount: 100_000, appliedTermDays: 30, status: "CANCELLED" } })
        expect(await db.payment.count({ where: { id: { in: [direct.id, viaCode.payment.id] } } })).toBe(2)
        expect(await db.loanApplication.count({ where: { id: app.id } })).toBe(1)
        expect(await events("payment.received", direct.id)).toBe(0)
        expect(await events("application.created", app.id)).toBe(0)
        // Review round 2: a swallowed failure is counted, so the loss is visible.
        const lost = await db.webhookOutboxFailure.findMany({ where: { tenantId: A.tenantId, entityId: { in: [direct.id, viaCode.payment.id, app.id] } } })
        expect(lost.map((f) => f.type).sort()).toEqual(["application.created", "payment.received", "payment.received"])
        expect(lost[0].error).toMatch(/forced outbox failure/)
      } finally {
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.webhook_enqueue(text, text, text, jsonb)`)
        await db.$executeRawUnsafe(`ALTER FUNCTION public.webhook_enqueue_saved_it(text, text, text, jsonb) RENAME TO webhook_enqueue`)
      }
      const after = await db.payment.create({ data: { tenantId: A.tenantId, loanId: A.loanId, amount: 1_000 } })
      expect(await events("payment.received", after.id)).toBe(1)
    })
  })

  it("prunes request logs and finished deliveries past retention, keeping pending ones", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000)
    await db.apiRequestLog.create({ data: { tenantId: A.tenantId, method: "GET", path: "/api/v1/old", status: 200, durationMs: 1, createdAt: old } })
    await db.webhookOutboxFailure.create({ data: { tenantId: A.tenantId, type: "payment.received", entityId: "old-lost", error: "synthetic", createdAt: old } })
    const ep = await db.webhookEndpoint.findFirstOrThrow({ where: { tenantId: B.tenantId } })
    const evDone = await db.webhookEvent.create({ data: { tenantId: B.tenantId, type: "payment.received", entityId: "old1", data: {}, dispatchedAt: old, createdAt: old } })
    const evWaiting = await db.webhookEvent.create({ data: { tenantId: B.tenantId, type: "payment.received", entityId: "old2", data: {}, dispatchedAt: old, createdAt: old } })
    await db.webhookDelivery.create({ data: { tenantId: B.tenantId, endpointId: ep.id, eventId: evDone.id, status: "SUCCEEDED", createdAt: old } })
    await db.webhookDelivery.create({ data: { tenantId: B.tenantId, endpointId: ep.id, eventId: evWaiting.id, status: "PENDING", createdAt: old, nextAttemptAt: new Date(Date.now() + 86_400_000) } })

    const r = await pruneLenderApiLogs()
    expect(r.apiRequestLogs).toBeGreaterThanOrEqual(1)
    expect(await db.apiRequestLog.count({ where: { path: "/api/v1/old" } })).toBe(0)
    expect(await db.webhookOutboxFailure.count({ where: { entityId: "old-lost" } })).toBe(0)
    expect(await db.webhookEvent.count({ where: { id: evDone.id } })).toBe(0)
    expect(await db.webhookEvent.count({ where: { id: evWaiting.id } })).toBe(1)
    expect(await db.webhookDelivery.count({ where: { eventId: evWaiting.id } })).toBe(1)
  })
})
