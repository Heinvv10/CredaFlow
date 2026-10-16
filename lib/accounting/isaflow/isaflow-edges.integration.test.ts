/**
 * The IsaFlow push at its edges, against real Postgres and the fake IsaFlow:
 * a company changed under a waiting push, a disconnect mid-push, two admins
 * at once, refusals during a resend and a read-back, rate limits, and the
 * exact stale cut-off. Each case closes its own month for its own tenant.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/isaflow/isaflow-edges.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import type { IsaFlowHttp } from "./client"
import { disconnectIsaFlow } from "./connection"
import { closeMonth, connectTenant, fakeWithDefaultChart, isaflowTenant, IT_KEY } from "./isaflow.integration-fixture"
import { pushBatchToIsaFlow, resolveIsaFlowPush } from "./push"
import { markStaleIsaFlowPush, STALE_SENDING_MS } from "./push-record"
import { checkIsaFlowPush } from "./retry"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fake = fakeWithDefaultChart()
const other = fakeWithDefaultChart()
type T = Awaited<ReturnType<typeof isaflowTenant>>
type Who = { id: string; email: string }
const me = (t: T): Who => ({ id: t.userId, email: t.email })
const push = (t: T, batchId: string, actor: Who = me(t), http: IsaFlowHttp = {}) => pushBatchToIsaFlow(prisma, { tenantId: t.tenantId, batchId, actor }, http)
const check = (t: T, batchId: string, actor: Who = me(t)) => checkIsaFlowPush(prisma, { tenantId: t.tenantId, batchId, actor })
const drafts = (f: typeof fake, batchId: string) => f.listDrafts().filter((d) => d.description?.includes(`[credaflow:${batchId}]`))
const row = (batchId: string) => db.accountingIsaFlowPush.findUniqueOrThrow({ where: { batchId } })
const connection = (t: T) => db.isaFlowConnection.findUniqueOrThrow({ where: { tenantId: t.tenantId } })
const calls = (f: typeof fake, tool: string, batchId?: string) => f.calls.filter((c) => c.tool === tool && (!batchId || c.rawBody.includes(batchId))).length
const reconnectAudits = (t: T) => db.auditLog.count({ where: { tenantId: t.tenantId, action: "ISAFLOW_NEEDS_RECONNECT" } })

async function month(): Promise<{ t: T; batch: string }> {
  const t = await isaflowTenant(db)
  await connectTenant(t, fake)
  return { t, batch: await closeMonth(db, t, "2026-08", new Date("2026-11-01T00:00:00Z")) }
}

async function secondAdmin(t: T): Promise<Who> {
  const user = await db.user.create({ data: { id: `u_${randomUUID()}`, tenantId: t.tenantId, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })
  return { id: user.id, email: user.email }
}

suite.sequential("IsaFlow push edges (real Postgres, fake IsaFlow)", () => {
  beforeAll(async () => {
    await fake.start()
    await other.start()
    vi.stubEnv("WABA_ENC_KEY", IT_KEY)
    vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", `${fake.url},${other.url}`)
    vi.stubEnv("NODE_ENV", "test")
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await fake.stop()
    await other.stop()
    await db.$disconnect()
  })

  it("a push built for one IsaFlow company is never retried into another the tenant connected since", async () => {
    const { t, batch } = await month()
    fake.failNext("refuse")
    expect(await push(t, batch)).toMatchObject({ status: "FAILED" })
    await connectTenant(t, other)
    const before = [calls(fake, "list_journals"), calls(fake, "create_draft_journal"), calls(other, "list_journals"), calls(other, "create_draft_journal")]
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("different company") })
    expect([calls(fake, "list_journals"), calls(fake, "create_draft_journal"), calls(other, "list_journals"), calls(other, "create_draft_journal")]).toEqual(before)
    expect(await row(batch)).toMatchObject({ status: "FAILED", isaflowCompanyId: fake.companyId })
    expect(drafts(other, batch)).toHaveLength(0)
  })

  it("a disconnect while a push is in flight: the push in flight lands; nothing after it reaches IsaFlow", async () => {
    const { t, batch } = await month()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const inFlight = new Promise<void>((r) => { entered = r })
    const slow: typeof fetch = async (url, init) => {
      if (String(init?.body).includes("create_draft_journal")) { entered(); await gate }
      return fetch(url, init)
    }
    const pending = push(t, batch, me(t), { fetch: slow })
    await inFlight
    await prisma.$transaction((tx) => disconnectIsaFlow(tx, { tenantId: t.tenantId, actor: me(t), ip: null }))
    release()
    expect(await pending).toMatchObject({ ok: true, status: "PUSHED" })
    expect(await connection(t)).toMatchObject({ status: "DISCONNECTED", tokenSealed: null })
    expect(drafts(fake, batch)).toHaveLength(1)

    // A claim stuck SENDING when the tenant disconnected waits for review; nothing is resent.
    const next = await closeMonth(db, t, "2026-09", new Date("2026-11-01T00:00:00Z"))
    await connectTenant(t, fake)
    fake.commitThenDrop()
    expect(await push(t, next)).toMatchObject({ status: "NEEDS_REVIEW" })
    await db.accountingIsaFlowPush.update({ where: { batchId: next }, data: { status: "SENDING" } })
    await prisma.$transaction((tx) => disconnectIsaFlow(tx, { tenantId: t.tenantId, actor: me(t), ip: null }))
    expect(await markStaleIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: next, actor: me(t), now: new Date(Date.now() + STALE_SENDING_MS + 1000) })).toBe(true)
    const creates = calls(fake, "create_draft_journal", next)
    expect(await check(t, next)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("Connect IsaFlow") })
    expect(await row(next)).toMatchObject({ status: "NEEDS_REVIEW" })
    expect(calls(fake, "create_draft_journal", next)).toBe(creates)
  })

  it("two admins at once: a check and a push of a push in review, then a retry and a check of a failed one, give one draft", async () => {
    const { t, batch } = await month()
    const other_admin = await secondAdmin(t)
    fake.commitThenDrop()
    expect(await push(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    const [checked, pushed] = await Promise.all([check(t, batch), push(t, batch, other_admin)])
    expect(checked).toMatchObject({ ok: true, foundOnReadBack: true })
    expect(pushed).toMatchObject({ ok: false, httpStatus: 409 })
    expect(drafts(fake, batch)).toHaveLength(1)

    const next = await closeMonth(db, t, "2026-09", new Date("2026-11-01T00:00:00Z"))
    fake.failNext("refuse")
    expect(await push(t, next)).toMatchObject({ status: "FAILED" })
    const out = await Promise.all([push(t, next), check(t, next, other_admin), push(t, next, other_admin)])
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    expect(drafts(fake, next)).toHaveLength(1)
    const final = await row(next)
    expect(final.status).toBe("PUSHED")
    expect([t.userId, other_admin.id]).toContain(final.pushedById)
  })

  it("a 401 during the resend fails the push, drops the token (audited) and leaves no draft; reconnecting pushes it once", async () => {
    const { t, batch } = await month()
    fake.failNext("500")
    expect(await push(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    fake.failNext("401")
    expect(await check(t, batch)).toMatchObject({ ok: false, status: "FAILED", error: expect.stringContaining("401") })
    expect(await row(batch)).toMatchObject({ status: "FAILED", isaflowJournalId: null })
    expect(await connection(t)).toMatchObject({ status: "NEEDS_RECONNECT", tokenSealed: null })
    expect(await reconnectAudits(t)).toBe(1)
    expect(drafts(fake, batch)).toHaveLength(0)
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("Connect IsaFlow") })
    await connectTenant(t, fake)
    expect(await push(t, batch)).toMatchObject({ ok: true, status: "PUSHED" })
    expect(drafts(fake, batch)).toHaveLength(1)
  })

  it("HTTP 429 and the -32000 rate limit are definite: FAILED, nothing created, a later push creates one draft", async () => {
    for (const kind of ["429", "rate"] as const) {
      const { t, batch } = await month()
      fake.failNext(kind)
      expect(await push(t, batch), kind).toMatchObject({ ok: false, status: "FAILED" })
      expect(drafts(fake, batch), kind).toHaveLength(0)
      expect(await push(t, batch), kind).toMatchObject({ ok: true, status: "PUSHED" })
      expect(drafts(fake, batch), kind).toHaveLength(1)
    }
    const { t, batch } = await month()
    fake.failNext("429", "list_gl_accounts")
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 502, status: null })
    expect(await db.accountingIsaFlowPush.findUnique({ where: { batchId: batch } })).toBeNull()
  })

  it("a SENDING claim is stale only after exactly 10 minutes, not at 10 minutes", async () => {
    const { t, batch } = await month()
    fake.commitThenDrop()
    await push(t, batch)
    await db.accountingIsaFlowPush.update({ where: { batchId: batch }, data: { status: "SENDING" } })
    const { updatedAt } = await row(batch)
    const at = (ms: number) => markStaleIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, actor: me(t), now: new Date(updatedAt.getTime() + ms) })
    expect(await at(STALE_SENDING_MS)).toBe(false)
    expect(await at(STALE_SENDING_MS + 1)).toBe(true)
  })

  it("a failed read-back sends nothing and returns the push to where it was; an auth refusal there drops the token", async () => {
    const { t, batch } = await month()
    fake.failNext("refuse")
    expect(await push(t, batch)).toMatchObject({ status: "FAILED" })
    const creates = calls(fake, "create_draft_journal", batch)
    fake.failNext("500", "list_journals")
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 502, status: "FAILED", error: expect.stringContaining("nothing was resent") })
    expect(await row(batch)).toMatchObject({ status: "FAILED" })

    const next = await closeMonth(db, t, "2026-09", new Date("2026-11-01T00:00:00Z"))
    fake.commitThenDrop()
    expect(await push(t, next)).toMatchObject({ status: "NEEDS_REVIEW" })
    fake.failNext("500", "list_journals")
    expect(await check(t, next)).toMatchObject({ ok: false, status: "NEEDS_REVIEW" })
    expect(await row(next)).toMatchObject({ status: "NEEDS_REVIEW" })

    fake.failNext("401", "list_journals")
    expect(await push(t, batch)).toMatchObject({ ok: false, status: "FAILED" })
    expect(await connection(t)).toMatchObject({ status: "NEEDS_RECONNECT" })
    expect(await reconnectAudits(t)).toBe(1)
    expect(calls(fake, "create_draft_journal", batch)).toBe(creates)
  })

  it("each resolution names its own resolver: a retry sheds the earlier one, and the same admin may resolve again", async () => {
    const { t, batch } = await month()
    fake.failNext("500")
    expect(await push(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    expect(await resolveIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, outcome: "not_pushed", journalId: null, note: "not in IsaFlow drafts", actor: me(t) })).toBe(true)
    expect(await row(batch)).toMatchObject({ status: "FAILED", resolvedById: t.userId })
    fake.failNext("500")
    expect(await push(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    expect(await row(batch)).toMatchObject({ status: "NEEDS_REVIEW", resolvedById: null, resolutionNote: null })
    expect(await resolveIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, outcome: "not_pushed", journalId: null, note: "still not there", actor: me(t) })).toBe(true)
    expect(await row(batch)).toMatchObject({ status: "FAILED", resolvedById: t.userId, resolutionNote: "still not there" })
  })

  it("an auth refusal reading the chart drops the token (audited) and claims nothing", async () => {
    const { t, batch } = await month()
    fake.failNext("401", "list_gl_accounts")
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 502, status: null })
    expect(await connection(t)).toMatchObject({ status: "NEEDS_RECONNECT", tokenSealed: null })
    expect(await reconnectAudits(t)).toBe(1)
    expect(await db.accountingIsaFlowPush.findUnique({ where: { batchId: batch } })).toBeNull()
  })
})
