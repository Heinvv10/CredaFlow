/** Round 2 probes against the new trigger clauses and token-drop audit (real Postgres). */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { closeMonth, connectTenant, fakeWithDefaultChart, isaflowTenant, IT_KEY } from "./isaflow.integration-fixture"
import { markIsaFlowNeedsReconnect } from "./connection"
import { resolveIsaFlowPush, pushBatchToIsaFlow } from "./push"
import { checkIsaFlowPush } from "./retry"
import { sha256Hex } from "./journal"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient({ errorFormat: "minimal" })
const fake = fakeWithDefaultChart()
type T = Awaited<ReturnType<typeof isaflowTenant>>
let A: T, B: T
const request = (b: string) => JSON.stringify({ date: "2026-08-31", memo: `m [credaflow:${b}]`, idempotency_key: `credaflow:batch:${b}` })
const claim = (t: T, batchId: string, over: Record<string, unknown> = {}) => db.accountingIsaFlowPush.create({
  data: { tenantId: t.tenantId, batchId, status: "SENDING", externalRef: batchId, idempotencyKey: `credaflow:batch:${batchId}`, requestJson: request(batchId), requestSha256: sha256Hex(request(batchId)), isaflowCompanyId: "co-1", pushedById: t.userId, ...over } as never,
})
const act = (t: T) => ({ id: t.userId, email: t.email })

suite.sequential("round 2 guards", () => {
  beforeAll(async () => {
    await fake.start()
    vi.stubEnv("WABA_ENC_KEY", IT_KEY); vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", fake.url); vi.stubEnv("NODE_ENV", "test")
    A = await isaflowTenant(db); B = await isaflowTenant(db)
  })
  afterAll(async () => { vi.unstubAllEnvs(); await fake.stop(); await db.$disconnect() })

  it("INSERT: a claim carries no journal, resolution, note or read-back flag, and is by a user of its tenant", async () => {
    const b = await closeMonth(db, A, "2026-08", new Date("2026-11-01T00:00:00Z"))
    for (const over of [{ isaflowJournalId: "j" }, { resolvedById: A.userId }, { resolutionNote: "n" }, { foundOnReadBack: true }, { pushedById: B.userId }, { pushedById: "no-such-user" }]) {
      await expect(claim(A, b, over), JSON.stringify(over)).rejects.toThrow()
    }
    expect(await db.accountingIsaFlowPush.count({ where: { batchId: b } })).toBe(0)
    await claim(A, b)
  })

  it("UPDATE: out of review needs a resolver of the tenant; a resend (to SENDING) does not", async () => {
    const b = await closeMonth(db, A, "2026-09", new Date("2026-11-01T00:00:00Z"))
    await claim(A, b)
    await db.accountingIsaFlowPush.update({ where: { batchId: b }, data: { status: "NEEDS_REVIEW" } })
    const to = (data: Record<string, unknown>) => db.accountingIsaFlowPush.update({ where: { batchId: b }, data })
    await expect(to({ status: "FAILED" })).rejects.toThrow(/resolved by a user of its tenant/)
    await expect(to({ status: "FAILED", resolvedById: B.userId })).rejects.toThrow(/resolved by a user of its tenant/)
    await expect(to({ status: "FAILED", resolvedById: "ghost" })).rejects.toThrow()
    await expect(to({ status: "PUSHED", isaflowJournalId: "j", resolvedById: null })).rejects.toThrow(/resolved by a user of its tenant/)
    await expect(to({ pushedById: B.userId })).rejects.toThrow(/claimed by a user of its tenant/)
    await to({ status: "SENDING" })
    await to({ status: "NEEDS_REVIEW" })
    await to({ status: "FAILED", resolvedById: A.userId, resolutionNote: "checked" })
  })

  it("real resolve and check/resend flows still pass the new clauses end to end", async () => {
    await connectTenant(A, fake)
    const b = await closeMonth(db, A, "2026-10", new Date("2026-11-01T00:00:00Z"))
    fake.commitThenDrop()
    expect(await pushBatchToIsaFlow(prisma, { tenantId: A.tenantId, batchId: b, actor: act(A) })).toMatchObject({ status: "NEEDS_REVIEW" })
    expect(await resolveIsaFlowPush(prisma, { tenantId: A.tenantId, batchId: b, outcome: "not_pushed", journalId: null, note: "looked, absent", actor: act(A) })).toBe(true)
    expect(await pushBatchToIsaFlow(prisma, { tenantId: A.tenantId, batchId: b, actor: act(A) })).toMatchObject({ ok: true })
    expect(await checkIsaFlowPush(prisma, { tenantId: A.tenantId, batchId: b, actor: act(A) })).toMatchObject({ ok: false, httpStatus: 409 })
    expect(fake.listDrafts().filter((d) => d.description?.includes(`[credaflow:${b}]`))).toHaveLength(1)
  })

  it("token drop: audited exactly once with the actor and no token; a second call on a dropped connection writes nothing", async () => {
    await connectTenant(B, fake)
    const before = await db.auditLog.count({ where: { tenantId: B.tenantId, action: "ISAFLOW_NEEDS_RECONNECT" } })
    expect(await prisma.$transaction((tx) => markIsaFlowNeedsReconnect(tx, { tenantId: B.tenantId, actor: act(B), reason: "401 pat_isaflow_it_0123456789abcdef" }))).toBe(true)
    expect(await prisma.$transaction((tx) => markIsaFlowNeedsReconnect(tx, { tenantId: B.tenantId, actor: act(B), reason: "again" }))).toBe(false)
    const rows = await db.auditLog.findMany({ where: { tenantId: B.tenantId, action: "ISAFLOW_NEEDS_RECONNECT" } })
    expect(rows).toHaveLength(before + 1)
    // The reason came in carrying the token: the audit row must not.
    expect(JSON.stringify(rows)).not.toContain("pat_isaflow_it_0123456789abcdef")
    expect(await db.isaFlowConnection.findUniqueOrThrow({ where: { tenantId: B.tenantId } })).toMatchObject({ status: "NEEDS_RECONNECT", tokenSealed: null })
  })
})
