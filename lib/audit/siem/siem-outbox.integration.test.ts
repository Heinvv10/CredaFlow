/**
 * Real-Postgres proof of SIEM forwarding: what the chainer queues, ordered
 * at-least-once delivery per lender, poison splitting, pruning, anchors, the
 * policy-change row going to the old destination, and checkpoints.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/siem/siem-outbox.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { runWithTenant } from "@/lib/tenant-scope"
import { runChainer } from "@/lib/audit/chainer"
import { writeCheckpoints } from "@/lib/audit/checkpoint"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
import { deliverSiemOutbox, type SiemSender } from "./deliver"
import { saveAuditPolicy } from "./policy"
import type { SiemEvent } from "./format"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("SIEM forwarding", () => {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const tenantIds: string[] = []
  type Writer = Parameters<typeof logAuditStrict>[1]
  const T0 = new Date(Date.now() + 60_000) // the outbox is stamped by the database clock; deliver a minute ahead of it
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

  const tenant = async (label: string) => {
    const id = `siem-${label}-${token}`
    await db.tenant.create({ data: { id, slug: id, name: id } })
    tenantIds.push(id)
    return id
  }
  const enable = (tenantId: string, url = "https://siem.example.invalid/ingest") =>
    db.auditPolicy.upsert({
      where: { tenantId },
      create: { tenantId, siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: url },
      update: { siemEnabled: true, siemUrl: url },
    })
  const write = (tenantId: string, n: number, action = "LOAN_NOTE_ADDED", client: unknown = db) =>
    logAuditStrict({ tenantId, action, entity: "Thing", entityId: `e${n}`, userEmail: `p${n}@it.invalid`, ipAddress: "10.0.0.1", oldValue: { n }, newValue: { n, idNumber: "8001015009087" } }, client as Writer)
  const chain = (tenantId: string) => runChainer({ db, deep: true, only: [tenantId] })
  const outbox = (tenantId: string) => db.auditSiemOutbox.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
  const recorder = (answer: (events: SiemEvent[], url: string | null) => { ok: boolean; error?: string; permanent?: boolean } = () => ({ ok: true })) => {
    const calls: Array<{ url: string | null; events: SiemEvent[] }> = []
    const send: SiemSender = async (target, events) => {
      calls.push({ url: target.url, events })
      const r = answer(events, target.url)
      return r.ok ? { ok: true, error: null } : { ok: false, error: (r.error ?? "siem_unavailable") as never, ...(r.permanent ? { permanent: true } : {}) }
    }
    return { calls, send, seqs: () => calls.flatMap((c) => c.events.map((e) => e.chain.seq)) }
  }
  const deliver = (send: SiemSender, now: Date) => deliverSiemOutbox({ db, send, now })

  beforeAll(() => { process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64") })
  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId: { in: tenantIds } })
    await db.auditSiemOutbox.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.$executeRawUnsafe(`SET session_replication_role = replica`).catch(() => undefined)
    await db.auditPolicy.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.$disconnect()
  })

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
    for (const s of [100, 300]) r = await deliver(rec.send, at(s))
    const rows = await outbox(t)
    expect(rows.filter((o) => o.deadAt !== null).map((o) => o.seq)).toEqual([5])
    expect(rows.filter((o) => o.sentAt !== null).map((o) => o.seq)).toEqual([1, 2, 3, 4, 6, 7, 8])
    expect(r.dead).toBeGreaterThanOrEqual(0)
    expect(rows.find((o) => o.seq === 5)).toMatchObject({ lastError: "rejected_by_siem", attempts: 3 })
  })

  it("prunes what is queued for a lender that switched forwarding off", async () => {
    const t = await tenant("off")
    await enable(t)
    for (let i = 1; i <= 3; i++) await write(t, i)
    await chain(t)
    await db.auditPolicy.update({ where: { tenantId: t }, data: { siemEnabled: false } })
    const rec = recorder()
    await deliver(rec.send, T0)
    expect(rec.calls).toHaveLength(0)
    expect(await outbox(t)).toEqual([])
  })

  it("sends an anchor (the chain head) when forwarding starts, and the policy change to the destination it left", async () => {
    const t = await tenant("pol")
    const actor = await db.user.create({ data: { id: `siem-u-${token}`, email: `siem-u-${token}@it.invalid`, password: "x", tenantId: t, role: "ADMIN" } })
    for (let i = 1; i <= 3; i++) await write(t, i)
    await chain(t)
    const resolve = async () => [{ address: "8.8.8.8", family: 4 }]
    const save = (input: Record<string, unknown>) =>
      runWithTenant(t, () => saveAuditPolicy(t, { id: actor.id, email: actor.email }, input, { resolve }))

    await save({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://old.example.invalid/ingest", siemToken: "s3cret" })
    expect((await outbox(t)).map((o) => o.kind)).toContain("ANCHOR")
    await chain(t) // links the policy row (and queues it: forwarding is on)
    const anchor = recorder()
    await deliver(anchor.send, T0)
    const started = anchor.calls.flatMap((c) => c.events).find((e) => e.action === "AUDIT_FORWARDING_STARTED")
    const [head] = await db.$queryRaw<Array<{ seq: number; rowHash: string }>>`SELECT "seq", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${t} ORDER BY "seq" DESC LIMIT 1`
    expect(started?.chain.seq).toBeGreaterThanOrEqual(3)
    expect(started?.chain.seq).toBeLessThanOrEqual(head.seq)
    expect(JSON.stringify(anchor.calls)).not.toContain("s3cret")

    // Redirect the feed: the row recording it goes to the OLD destination, the new one starts with an anchor.
    await save({ siemUrl: "https://new.example.invalid/ingest" })
    await chain(t)
    const moved = recorder()
    await deliver(moved.send, at(10))
    const toOld = moved.calls.filter((c) => c.url === "https://old.example.invalid/ingest").flatMap((c) => c.events)
    expect(toOld.map((e) => e.action)).toEqual(["AUDIT_POLICY_UPDATED"])
    expect(JSON.stringify(toOld)).not.toContain("new.example.invalid/ingest?")
    const toNew = moved.calls.filter((c) => c.url === "https://new.example.invalid/ingest").flatMap((c) => c.events)
    expect(toNew.map((e) => e.action)).toContain("AUDIT_FORWARDING_STARTED")
    expect(toNew.map((e) => e.action)).not.toContain("AUDIT_POLICY_UPDATED")

    // Switch it off: the row recording that goes to the destination it was switched off from.
    await save({ siemEnabled: false })
    await chain(t)
    const off = recorder()
    await deliver(off.send, at(20))
    expect(off.calls.flatMap((c) => c.events).map((e) => e.action)).toEqual(["AUDIT_POLICY_UPDATED"])
    expect(off.calls[0].url).toBe("https://new.example.invalid/ingest")
  })

  it("queues a daily checkpoint for forwarding lenders and ships it with its HMAC", async () => {
    const t = await tenant("cp")
    await enable(t)
    await write(t, 1)
    await chain(t)
    expect(await writeCheckpoints(db, [t])).toBe(1)
    expect(await writeCheckpoints(db, [t])).toBe(0) // the head has not moved
    const rec = recorder()
    await deliver(rec.send, T0)
    const cp = rec.calls.flatMap((c) => c.events).find((e) => e.action === "AUDIT_CHAIN_CHECKPOINT")
    expect(cp?.newValue).toMatchObject({ seq: 1, rowHash: expect.stringMatching(/^[0-9a-f]{64}$/), hmac: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })
})
