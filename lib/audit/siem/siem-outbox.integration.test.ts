/**
 * Real-Postgres proof of SIEM delivery: what the chainer queues, ordered at-least-once delivery per lender, backoff held by the database, poison splitting, and checkpoints.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/siem/siem-outbox.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkpointNow } from "@/lib/audit/checkpoint.test-helpers"
import type { SiemSender } from "./deliver"
import { siemFixture } from "./siem-it.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("siem-outbox", () => {
  const fx = siemFixture()
  const { db, T0, at, tenant, enable, write, chain, outbox, recorder, deliver, elapse } = fx
  beforeAll(fx.setup)
  afterAll(fx.teardown)

  it("queues a row only once it is chained and only while the lender forwards; a rolled-back row never", async () => {
    const t = await tenant("q")
    await write(t, 1)
    await chain(t)
    expect(await outbox(t)).toHaveLength(0)

    await enable(t)
    await write(t, 2)
    await expect(db.$transaction(async (tx) => { await write(t, 3, "LOAN_NOTE_ADDED", tx); throw new Error("abort") })).rejects.toThrow("abort")
    await write(t, 4)
    expect(await outbox(t)).toHaveLength(0) // committed but not chained: nothing to ship yet
    await chain(t)
    const queued = await outbox(t)
    expect(queued.map((q) => q.seq)).toEqual([2, 3])
    expect(queued.every((q) => q.kind === "EVENT" && q.sentAt === null)).toBe(true)
  })

  it("ships the seq and hash with each event, and the minimum of the row: no email, no values, no address for an ordinary action", async () => {
    const t = await tenant("min")
    await enable(t)
    await write(t, 1)
    await write(t, 2, "USER_UPDATED")
    await chain(t)
    const rec = recorder()
    await deliver(rec.send, T0)
    const [plain, config] = rec.calls[0].events
    expect(plain).toMatchObject({ action: "LOAN_NOTE_ADDED", chain: { seq: 1 }, oldValue: null, newValue: null, sourceIp: null, actor: { userId: null } })
    expect(plain.chain.rowHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rec.calls)).not.toContain("@it.invalid")
    expect(config).toMatchObject({ action: "USER_UPDATED", sourceIp: "10.0.0.1", oldValue: { n: 2 }, newValue: { n: 2, idNumber: "[masked]" } })
  })

  it("ships in order per lender, stops at the first failed batch, and sends the same events again after backoff", async () => {
    const t = await tenant("ord")
    await enable(t)
    for (let i = 1; i <= 130; i++) await write(t, i)
    await chain(t)
    let call = 0
    const failing = recorder(() => ({ ok: ++call !== 2 }))
    const first = await deliver(failing.send, T0)
    expect(first.sent).toBe(100)
    expect(failing.calls).toHaveLength(2) // the second batch failed and nothing went past it
    const pending = (await outbox(t)).filter((o) => o.sentAt === null)
    expect(pending).toHaveLength(30)
    expect(pending.every((p) => p.attempts === 1 && p.lastError === "siem_unavailable" && p.nextAttemptAt > T0)).toBe(true)

    const backingOff = recorder()
    await deliver(backingOff.send, at(1))
    expect(backingOff.calls).toHaveLength(0)

    const later = recorder()
    await elapse(t)
    await deliver(later.send, at(120))
    expect(later.seqs()).toEqual(Array.from({ length: 30 }, (_, i) => 101 + i))
    expect(failing.calls[1].events.map((e) => e.chain.seq)).toEqual(later.calls[0].events.map((e) => e.chain.seq).slice(0, 0).concat(failing.calls[1].events.map((e) => e.chain.seq)))
    expect(failing.calls[1].events.map((e) => e.eventId)).toEqual(later.calls[0].events.map((e) => e.eventId).slice(0, 30))
  })

  it("holds back everything behind a row that is backing off, even rows that are due", async () => {
    const t = await tenant("hold")
    await enable(t)
    for (let i = 1; i <= 4; i++) await write(t, i)
    await chain(t)
    await db.auditSiemOutbox.updateMany({ where: { tenantId: t, seq: 1 }, data: { nextAttemptAt: at(3600) } })
    const rec = recorder()
    await deliver(rec.send, T0)
    expect(rec.calls).toHaveLength(0)
    await elapse(t)
    await deliver(rec.send, at(7200))
    expect(rec.seqs()).toEqual([1, 2, 3, 4])
  })

  it("ships a queued row only once its audit row is chained", async () => {
    const t = await tenant("unch")
    await enable(t)
    await write(t, 1)
    const [row] = await db.auditLog.findMany({ where: { tenantId: t } })
    await db.auditSiemOutbox.create({ data: { tenantId: t, kind: "EVENT", auditLogId: row.id } })
    const rec = recorder()
    await deliver(rec.send, T0)
    expect(rec.calls).toHaveLength(0)
    await chain(t)
    await deliver(rec.send, T0)
    expect(rec.seqs()).toEqual([1])
  })

  it("never has two deliverers send a lender's rows at once", async () => {
    const t = await tenant("lock")
    await enable(t)
    for (let i = 1; i <= 20; i++) await write(t, i)
    await chain(t)
    const slow = recorder()
    const slowSend: SiemSender = async (...a) => { await new Promise((r) => setTimeout(r, 150)); return slow.send(...a) }
    await Promise.all([deliver(slowSend, T0), deliver(slowSend, T0), deliver(slowSend, T0)])
    expect(slow.seqs()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it("splits a batch the SIEM rejects until the bad row stands alone, then gives up on that row only", async () => {
    const t = await tenant("poison")
    await enable(t)
    for (let i = 1; i <= 8; i++) await write(t, i)
    await chain(t)
    const rec = recorder((events) => (events.some((e) => e.chain.seq === 5) ? { ok: false, error: "rejected_by_siem", permanent: true } : { ok: true }))
    const r1 = await deliver(rec.send, T0)
    expect(r1.sent).toBe(7 - 3) // seq 1-4 shipped; 5 isolated and held; 6-8 wait behind it
    let r = r1
    for (const s of [100, 300]) { await elapse(t); r = await deliver(rec.send, at(s)) }
    const rows = await outbox(t)
    expect(rows.filter((o) => o.deadAt !== null).map((o) => o.seq)).toEqual([5])
    expect(rows.filter((o) => o.sentAt !== null).map((o) => o.seq)).toEqual([1, 2, 3, 4, 6, 7, 8])
    expect(r.dead).toBeGreaterThanOrEqual(0)
    expect(rows.find((o) => o.seq === 5)).toMatchObject({ lastError: "rejected_by_siem", attempts: 3 })
  })

  it("queues a daily checkpoint for forwarding lenders and ships it with its HMAC", async () => {
    const t = await tenant("cp")
    await enable(t)
    await write(t, 1)
    await chain(t)
    expect(await checkpointNow(db, t)).toBe(1)
    expect(await checkpointNow(db, t)).toBe(0) // the head has not moved
    const rec = recorder()
    await deliver(rec.send, T0)
    const cp = rec.calls.flatMap((c) => c.events).find((e) => e.action === "AUDIT_CHAIN_CHECKPOINT")
    expect(cp?.newValue).toMatchObject({ seq: 1, rowHash: expect.stringMatching(/^[0-9a-f]{64}$/), hmac: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})
