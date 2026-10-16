/**
 * Real-Postgres proof of the IsaFlow push against the fake IsaFlow server
 * (fake-isaflow.integration-fixture.ts, real sockets): one draft per closed
 * month however often it is pushed, an unknown outcome resolved by reading
 * IsaFlow back, retries resent byte for byte under the batch's key, and
 * refusals before anything is sent or claimed.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/isaflow/isaflow.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { openSecret } from "@/lib/crypto/secret-box"
import { isaflowStatus } from "./connection"
import { closeMonth, connectTenant, fakeWithDefaultChart, isaflowTenant, IT_KEY, IT_TOKEN } from "./isaflow.integration-fixture"
import { pushBatchToIsaFlow, resolveIsaFlowPush } from "./push"
import { markStaleIsaFlowPush } from "./push-record"
import { checkIsaFlowPush } from "./retry"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fake = fakeWithDefaultChart()
let A: Awaited<ReturnType<typeof isaflowTenant>>
const actor = () => ({ id: A.userId, email: A.email })
const push = (batchId: string, tenantId = A.tenantId) => pushBatchToIsaFlow(prisma, { tenantId, batchId, actor: actor() })
const check = (batchId: string, tenantId = A.tenantId) => checkIsaFlowPush(prisma, { tenantId, batchId, actor: actor() })
const creates = (batchId: string) => fake.calls.filter((c) => c.tool === "create_draft_journal" && c.rawBody.includes(`credaflow:batch:${batchId}`))
const pushRow = (batchId: string) => db.accountingIsaFlowPush.findUnique({ where: { batchId } })

suite.sequential("IsaFlow push (real Postgres, fake IsaFlow)", () => {
  beforeAll(async () => {
    await fake.start()
    vi.stubEnv("WABA_ENC_KEY", IT_KEY)
    vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", fake.url)
    vi.stubEnv("NODE_ENV", "test")
    A = await isaflowTenant(db)
    await connectTenant(A, fake)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await fake.stop()
    await db.$disconnect()
  })

  it("connects to the token's company; the token is stored sealed and never shown", async () => {
    const row = await db.isaFlowConnection.findUniqueOrThrow({ where: { tenantId: A.tenantId } })
    expect(row).toMatchObject({ status: "CONNECTED", baseUrl: fake.url, isaflowCompanyId: fake.companyId, connectedWithTotp: true, connectedById: A.userId })
    expect(row.tokenSealed).not.toContain(IT_TOKEN)
    expect(openSecret(row.tokenSealed!, IT_KEY)).toBe(IT_TOKEN)
    expect(JSON.stringify(await isaflowStatus(prisma, A.tenantId))).not.toContain(IT_TOKEN)
  })

  it("two pushes give one draft: racing pushes claim once, a later push is refused without calling IsaFlow", async () => {
    const aug = await closeMonth(db, A, "2026-08", new Date("2026-11-01T00:00:00Z"))
    const [a, b] = await Promise.all([push(aug), push(aug)])
    const won = [a, b].filter((o) => o.ok)
    expect(won).toHaveLength(1)
    expect([a, b].find((o) => !o.ok)).toMatchObject({ httpStatus: 409 })
    expect(await push(aug)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("already in IsaFlow") })
    expect(creates(aug)).toHaveLength(1)
    const row = await pushRow(aug)
    expect(row).toMatchObject({ status: "PUSHED", idempotencyKey: `credaflow:batch:${aug}`, externalRef: aug, isaflowCompanyId: fake.companyId, foundOnReadBack: false })
    const draft = fake.listDrafts().find((d) => d.description?.includes(`[credaflow:${aug}]`))!
    expect(row!.isaflowJournalId).toBe(draft.id)
    expect(draft).toMatchObject({ status: "draft", entryDate: "2026-08-31" })
    const batch = await db.accountingExportBatch.findUniqueOrThrow({ where: { id: aug } })
    expect(Math.round(draft.amount * 100)).toBeLessThanOrEqual(Number(batch.totalDebitCents))
    expect(draft.lines!.reduce((s, l) => s + Math.round(l.debit * 100) - Math.round(l.credit * 100), 0)).toBe(0)
  })

  it("an unknown outcome waits for review; check finds the draft on read-back and records it without a second create", async () => {
    const sep = await closeMonth(db, A, "2026-09", new Date("2026-11-01T00:00:00Z"))
    fake.commitThenDrop()
    expect(await push(sep)).toMatchObject({ ok: false, status: "NEEDS_REVIEW" })
    expect(await push(sep)).toMatchObject({ ok: false, httpStatus: 409 })
    const out = await check(sep)
    const draft = fake.listDrafts().find((d) => d.description?.includes(`[credaflow:${sep}]`))!
    expect(out).toEqual({ ok: true, status: "PUSHED", journalId: draft.id, foundOnReadBack: true })
    expect(creates(sep).map((c) => c.outcome)).toEqual(["dropped"])
    expect(fake.listDrafts().filter((d) => d.description?.includes(`[credaflow:${sep}]`))).toHaveLength(1)
    expect(await pushRow(sep)).toMatchObject({ status: "PUSHED", foundOnReadBack: true, isaflowJournalId: draft.id })
  })

  it("a draft deleted in IsaFlow is resent byte for byte under the same key; IsaFlow replays, never duplicates", async () => {
    const oct = await closeMonth(db, A, "2026-10", new Date("2026-11-01T00:00:00Z"))
    fake.commitThenDrop()
    expect(await push(oct)).toMatchObject({ status: "NEEDS_REVIEW" })
    const deleted = fake.listDrafts().find((d) => d.description?.includes(`[credaflow:${oct}]`))!
    fake.deleteDraft(deleted.id)
    expect(await check(oct)).toEqual({ ok: true, status: "PUSHED", journalId: deleted.id, foundOnReadBack: false })
    const sent = creates(oct)
    expect(sent.map((c) => c.outcome)).toEqual(["dropped", "replayed"])
    const { requestJson } = (await pushRow(oct))!
    for (const call of sent) expect(call.rawBody).toContain(`"arguments":${requestJson}}`)
    expect(fake.listDrafts().some((d) => d.description?.includes(`[credaflow:${oct}]`))).toBe(false)
  })

  it("refuses a role without a stored mapping to the line's code before any request", async () => {
    const nov = await closeMonth(db, A, "2026-11", new Date("2026-12-02T00:00:00Z"))
    const calls = fake.calls.length
    await db.accountingAccountMapping.update({ where: { tenantId_role: { tenantId: A.tenantId, role: "INTEREST_INCOME" } }, data: { accountCode: "4001" } })
    const remapped = await push(nov)
    expect(remapped).toMatchObject({ ok: false, httpStatus: 422, error: expect.stringContaining("INTEREST_INCOME (4000)") })
    await db.accountingAccountMapping.update({ where: { tenantId_role: { tenantId: A.tenantId, role: "INTEREST_INCOME" } }, data: { accountCode: "4000" } })
    const fee = await db.accountingAccountMapping.delete({ where: { tenantId_role: { tenantId: A.tenantId, role: "FEE_INCOME" } } })
    expect(await push(nov)).toMatchObject({ ok: false, httpStatus: 422, error: expect.stringContaining("FEE_INCOME (4010)") })
    const { id: _id, ...restore } = fee
    await db.accountingAccountMapping.create({ data: restore })
    expect(fake.calls.length).toBe(calls)
    expect(await pushRow(nov)).toBeNull()
  })

  it("refuses a code IsaFlow lacks or has inactive with a 422 listing them, before any claim or create", async () => {
    const nov = (await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: A.tenantId, periodKey: "2026-11" } })).id
    const interest = fake.accounts.find((a) => a.account_code === "4000")!
    const loans = fake.accounts.find((a) => a.account_code === "1100")!
    interest.is_active = false
    loans.account_code = "1101"
    const out = await push(nov)
    interest.is_active = true
    loans.account_code = "1100"
    expect(out).toMatchObject({ ok: false, httpStatus: 422, codes: { missing: ["1100"], inactive: ["4000"], ambiguous: [] } })
    expect(await pushRow(nov)).toBeNull()
    expect(creates(nov)).toHaveLength(0)
  })

  it("a FAILED push is read back, then resent with the same bytes and key", async () => {
    const nov = (await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: A.tenantId, periodKey: "2026-11" } })).id
    fake.failNext("refuse")
    expect(await push(nov)).toMatchObject({ ok: false, status: "FAILED" })
    const reads = fake.calls.filter((c) => c.tool === "list_journals").length
    const out = await push(nov)
    expect(out).toMatchObject({ ok: true, status: "PUSHED", foundOnReadBack: false })
    expect(fake.calls.filter((c) => c.tool === "list_journals").length).toBe(reads + 1)
    const [first, second] = creates(nov)
    expect([first.outcome, second.outcome]).toEqual(["refused", "created"])
    expect(second.rawBody.slice(second.rawBody.indexOf('"arguments"'))).toBe(first.rawBody.slice(first.rawBody.indexOf('"arguments"')))
  })

  it("a SENDING claim older than 10 minutes moves to review; an auth refusal drops the token", async () => {
    const dec = await closeMonth(db, A, "2026-12", new Date("2027-01-02T00:00:00Z"))
    fake.failNext("401")
    expect(await push(dec)).toMatchObject({ ok: false, status: "FAILED" })
    expect(await db.isaFlowConnection.findUniqueOrThrow({ where: { tenantId: A.tenantId } })).toMatchObject({ status: "NEEDS_RECONNECT", tokenSealed: null })
    expect(await push(dec)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("Connect IsaFlow") })
    await connectTenant(A, fake)
    // A claim whose process died before recording an answer.
    await db.accountingIsaFlowPush.update({ where: { batchId: dec }, data: { status: "SENDING" } })
    expect(await check(dec)).toMatchObject({ ok: false, httpStatus: 409, error: expect.stringContaining("10 minutes") })
    expect(await markStaleIsaFlowPush(prisma, { tenantId: A.tenantId, batchId: dec, actor: actor(), now: new Date(Date.now() + 11 * 60_000) })).toBe(true)
    expect(await check(dec)).toMatchObject({ ok: true, status: "PUSHED", foundOnReadBack: false })
    expect(creates(dec).map((c) => c.outcome)).toEqual(["failed", "created"])
  })

  it("another tenant's batch is 404 to push, check and resolve, and touches nothing", async () => {
    const B = await isaflowTenant(db)
    const aug = (await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: A.tenantId, periodKey: "2026-08" } })).id
    const before = await pushRow(aug)
    const calls = fake.calls.length
    expect(await push(aug, B.tenantId)).toMatchObject({ ok: false, httpStatus: 404 })
    expect(await check(aug, B.tenantId)).toMatchObject({ ok: false, httpStatus: 404 })
    expect(await resolveIsaFlowPush(prisma, { tenantId: B.tenantId, batchId: aug, outcome: "not_pushed", journalId: null, note: "cross-tenant probe", actor: { id: B.userId, email: B.email } })).toBe(false)
    expect(await pushRow(aug)).toEqual(before)
    expect(fake.calls.length).toBe(calls)
  })

  it("no audit row carries the token", async () => {
    const rows = await db.auditLog.findMany({ where: { tenantId: A.tenantId } })
    expect(rows.some((r) => r.action === "ISAFLOW_CONNECTED")).toBe(true)
    expect(rows.some((r) => r.action === "ACCOUNTING_ISAFLOW_PUSH_READBACK")).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(IT_TOKEN)
    expect(JSON.stringify(rows)).not.toContain("enc:v1:")
  })
})
