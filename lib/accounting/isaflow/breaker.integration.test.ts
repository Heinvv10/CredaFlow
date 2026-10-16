/**
 * Breaker repros against real Postgres and the fake IsaFlow.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/accounting/isaflow/breaker.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { closeMonth, connectTenant, fakeWithDefaultChart, isaflowTenant, IT_KEY, IT_TOKEN } from "./isaflow.integration-fixture"
import { pushBatchToIsaFlow, resolveIsaFlowPush } from "./push"
import { checkIsaFlowPush } from "./retry"
import { STALE_SENDING_MS } from "./push-record"
import { isaflowStatus } from "./connection"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fake = fakeWithDefaultChart()
type T = Awaited<ReturnType<typeof isaflowTenant>>
const actor = (t: T) => ({ id: t.userId, email: t.email })
const push = (t: T, batchId: string, http = {}) => pushBatchToIsaFlow(prisma, { tenantId: t.tenantId, batchId, actor: actor(t) }, http)
const check = (t: T, batchId: string) => checkIsaFlowPush(prisma, { tenantId: t.tenantId, batchId, actor: actor(t) })
const drafts = (batchId: string) => fake.listDrafts().filter((d) => d.description?.includes(`[credaflow:${batchId}]`))
const rows = (batchId: string) => db.accountingIsaFlowPush.findMany({ where: { batchId } })
/** Backdates a push row past the stale cut-off; the row guard refuses a no-op update, so it is switched off for this statement only. */
const backdate = (batchId: string, minutes: number) => db.$transaction(async (tx) => {
  await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
  await tx.$executeRawUnsafe(`UPDATE "AccountingIsaFlowPush" SET "updatedAt" = now() - ($2 || ' minutes')::interval WHERE "batchId" = $1`, batchId, String(minutes))
})
const NOW = new Date("2027-03-01T00:00:00Z")

async function month(periodKey = "2026-08"): Promise<{ t: T; batch: string }> {
  const t = await isaflowTenant(db)
  await connectTenant(t, fake)
  return { t, batch: await closeMonth(db, t, periodKey, NOW) }
}

suite.sequential("breaker ITs", () => {
  beforeAll(async () => {
    await fake.start()
    vi.stubEnv("WABA_ENC_KEY", IT_KEY)
    vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", fake.url)
    vi.stubEnv("NODE_ENV", "test")
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await fake.stop()
    await db.$disconnect()
  })

  it("1: sequential, push+push, push+check give one draft and one PUSHED row", async () => {
    const { t, batch } = await month()
    const [a, b, c] = await Promise.all([push(t, batch), push(t, batch), check(t, batch)])
    expect([a, b, c].filter((o) => o.ok)).toHaveLength(1)
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 409 })
    expect(await check(t, batch)).toMatchObject({ ok: false, httpStatus: 409 })
    expect(drafts(batch)).toHaveLength(1)
    const r = await rows(batch)
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe("PUSHED")
  })

  it("1b: unknown outcome, then check+check+push at once: one draft, one PUSHED row", async () => {
    const { t, batch } = await month()
    fake.commitThenDrop()
    expect(await push(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    const out = await Promise.all([check(t, batch), check(t, batch), push(t, batch)])
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    expect(drafts(batch)).toHaveLength(1)
    expect((await rows(batch)).map((r) => r.status)).toEqual(["PUSHED"])
  })

  it("1c: FAILED, then push+push at once: one draft", async () => {
    const { t, batch } = await month()
    fake.failNext("refuse")
    expect(await push(t, batch)).toMatchObject({ status: "FAILED" })
    const out = await Promise.all([push(t, batch), push(t, batch)])
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    expect(drafts(batch)).toHaveLength(1)
  })

  it("2: unmapped tenant, and a mapping changed after the close, are refused with no HTTP call", async () => {
    const { t, batch } = await month()
    const before = fake.calls.length
    const role = (await db.accountingJournalLine.findFirstOrThrow({ where: { batchId: batch } })).role!
    await db.accountingAccountMapping.updateMany({ where: { tenantId: t.tenantId, role }, data: { accountCode: "9999" } })
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 422 })
    await db.accountingAccountMapping.deleteMany({ where: { tenantId: t.tenantId } })
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 422 })
    expect(fake.calls.length).toBe(before)
    expect(await rows(batch)).toHaveLength(0)
  })

  it("2b: a mapping changed AFTER the push still answers 422 instead of 409 'already in IsaFlow' (wrong status, harmless)", async () => {
    const { t, batch } = await month()
    expect(await push(t, batch)).toMatchObject({ ok: true })
    const role = (await db.accountingJournalLine.findFirstOrThrow({ where: { batchId: batch } })).role!
    await db.accountingAccountMapping.updateMany({ where: { tenantId: t.tenantId, role }, data: { accountCode: "9999" } })
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 409 })
  })

  it("3: the token appears in no audit column, push row, connection column but the sealed token, outcome or log", async () => {
    const logs: string[] = []
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")) }))
    const { t, batch } = await month()
    const outcomes = [] as unknown[]
    fake.failNext("500"); outcomes.push(await push(t, batch))
    outcomes.push(await check(t, batch))
    outcomes.push(await push(t, batch))
    fake.commitThenDrop()
    const b2 = await closeMonth(db, t, "2026-09", NOW)
    outcomes.push(await push(t, b2))
    outcomes.push(await resolveIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, outcome: "not_pushed", journalId: null, note: "x".repeat(6), actor: actor(t) }))
    outcomes.push(await check(t, b2))
    outcomes.push(await isaflowStatus(prisma, t.tenantId))
    spies.forEach((s) => s.mockRestore())
    const everything = JSON.stringify({
      outcomes, logs,
      audit: await db.auditLog.findMany({ where: { tenantId: t.tenantId } }),
      push: await rows(batch),
      conn: { ...(await db.isaFlowConnection.findUniqueOrThrow({ where: { tenantId: t.tenantId } })), tokenSealed: undefined },
    })
    expect(everything).not.toContain(IT_TOKEN)
    expect(everything).not.toContain("enc:v1:")
  })

  it("4: a stale-looking FAILED row, claimed by a retry, is NOT stale while that retry runs (updatedAt must move with the claim)", async () => {
    const { t, batch } = await month()
    fake.failNext("refuse")
    expect(await push(t, batch)).toMatchObject({ status: "FAILED" })
    await backdate(batch, 60)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const inFlight = new Promise<void>((r) => { entered = r })
    const slow: typeof fetch = async (url, init) => { entered(); await gate; return fetch(url, init) }
    const retry = push(t, batch, { fetch: slow })
    await inFlight
    const during = await check(t, batch)
    release()
    const done = await retry
    expect(during).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("10 minutes") })
    if (!done.ok) console.info("REPRO4", JSON.stringify(done))
    expect(done).toMatchObject({ ok: true })
    expect(drafts(batch)).toHaveLength(1)
  })

  it("5: failure matrix on create: 500 unknown, 401 reconnect, rate/refuse/flows/disabled definite; then one draft after a retry", async () => {
    const want = { "500": "NEEDS_REVIEW", "401": "FAILED", refuse: "FAILED", flows: "FAILED", disabled: "FAILED", rate: "FAILED" } as const
    for (const [kind, status] of Object.entries(want) as Array<[keyof typeof want, string]>) {
      const { t, batch } = await month()
      fake.failNext(kind)
      expect(await push(t, batch), kind).toMatchObject({ ok: false, status })
      if (kind === "401") await connectTenant(t, fake)
      const again = status === "NEEDS_REVIEW" ? await check(t, batch) : await push(t, batch)
      if (!again.ok) console.info("REPRO5", kind, JSON.stringify(again))
      expect(again, kind).toMatchObject({ ok: true })
      expect(drafts(batch), kind).toHaveLength(1)
      expect((await rows(batch)).map((r) => r.status), kind).toEqual(["PUSHED"])
    }
  })

  it("5b: chart read failing (500/401) claims nothing and sends nothing", async () => {
    const { t, batch } = await month()
    fake.failNext("500", "list_gl_accounts")
    expect(await push(t, batch)).toMatchObject({ ok: false, httpStatus: 502, status: null })
    expect(await rows(batch)).toHaveLength(0)
    expect(drafts(batch)).toHaveLength(0)
  })

  it("6: resolve 'pushed' accepts any journal id without asking IsaFlow (a person's word; note, not a finding)", async () => {
    const { t, batch } = await month()
    fake.commitThenDrop()
    await push(t, batch)
    expect(await resolveIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, outcome: "pushed", journalId: "not-a-real-id", note: "checked by hand", actor: actor(t) })).toBe(true)
    expect((await rows(batch))[0]).toMatchObject({ status: "PUSHED", isaflowJournalId: "not-a-real-id" })
  })

  it("7: after 'not_pushed' on a deleted draft the batch can never be pushed again (key replays the deleted id)", async () => {
    const { t, batch } = await month()
    fake.commitThenDrop()
    await push(t, batch)
    fake.deleteDraft(drafts(batch)[0].id)
    expect(await check(t, batch)).toMatchObject({ status: "NEEDS_REVIEW" })
    await resolveIsaFlowPush(prisma, { tenantId: t.tenantId, batchId: batch, outcome: "not_pushed", journalId: null, note: "deleted on purpose", actor: actor(t) })
    const again = await push(t, batch)
    console.info("REPRO7", JSON.stringify(again))
    expect(again).toMatchObject({ ok: true })
    expect(drafts(batch)).toHaveLength(1)
  })

  it("8: stale SENDING moves to review exactly once under concurrent checks", async () => {
    const { t, batch } = await month()
    fake.commitThenDrop()
    await push(t, batch)
    await db.accountingIsaFlowPush.update({ where: { batchId: batch }, data: { status: "SENDING" } })
    await backdate(batch, 11)
    const out = await Promise.all([check(t, batch), check(t, batch)])
    expect(out.filter((o) => o.ok)).toHaveLength(1)
    expect(drafts(batch)).toHaveLength(1)
    expect(STALE_SENDING_MS).toBe(600_000)
  })
})
