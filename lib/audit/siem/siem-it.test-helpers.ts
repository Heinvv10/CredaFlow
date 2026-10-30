/**
 * Shared setup for the SIEM integration suites (real Postgres, RUN_DB_IT=1): lenders made and torn
 * down, a policy switched on, audit rows written and chained, and a recording SIEM that answers as told.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { runChainer } from "@/lib/audit/chainer"
import { purgeAuditPolicyForTest, purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"
import { deliverSiemOutbox, type SiemSender } from "./deliver"
import type { SiemEvent } from "./format"

type Writer = Parameters<typeof logAuditStrict>[1]

export function siemFixture() {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const tenantIds: string[] = []
  const T0 = new Date(Date.now() + 60_000) // deliver a minute ahead of the database clock
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
  const chain = (tenantId: string) => runChainer({ db, mode: "full", only: [tenantId] })
  const outbox = (tenantId: string) => db.auditSiemOutbox.findMany({ where: { tenantId }, orderBy: { id: "asc" } })
  const recorder = (answer: (events: SiemEvent[], url: string | null) => { ok: boolean; error?: string; permanent?: boolean } = () => ({ ok: true })) => {
    const calls: Array<{ url: string | null; events: SiemEvent[] }> = []
    const send: SiemSender = async (target, events) => {
      calls.push({ url: target.url, events })
      const r = answer(events, target.url)
      return r.ok ? { ok: true, error: null, ackId: "ack-it" } : { ok: false, error: (r.error ?? "siem_unavailable") as never, ...(r.permanent ? { permanent: true } : {}) }
    }
    return { calls, send, seqs: () => calls.flatMap((c) => c.events.map((e) => e.chain.seq)) }
  }
  // Scoped to the lender the running test made last, so a lender another test left queued is not delivered into this recorder.
  const deliver = (send: SiemSender, now: Date, only: readonly string[] = tenantIds.slice(-1)) => deliverSiemOutbox({ db, send, now, only })
  /** The backoff of a lender's pending entries has elapsed (the database enforces it against its own clock). */
  const elapse = (tenantId: string) =>
    db.$executeRaw`UPDATE "AuditSiemOutbox" SET "nextAttemptAt" = now() - interval '1 second' WHERE "tenantId" = ${tenantId} AND "sentAt" IS NULL AND "deadAt" IS NULL`

  const setup = () => { process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64") }
  const teardown = async () => {
    await purgeAuditPolicyForTest(db, tenantIds)
    await purgeAuditRowsForTest(db, { tenantId: { in: tenantIds } })
    await db.auditSiemOutbox.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.user.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.$disconnect()
  }
  return { db, token, tenantIds, T0, at, tenant, enable, write, chain, outbox, recorder, deliver, elapse, setup, teardown }
}
