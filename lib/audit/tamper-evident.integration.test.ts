/**
 * Real-Postgres proof of the tamper-evident audit (migration 20261029100000):
 * append-only triggers, the hash chain under concurrent writes, tamper
 * detection by a superuser who bypasses the triggers, and the SIEM outbox.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/tamper-evident.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { verifyAuditChains } from "./chain-verify"
import { deliverSiemOutbox, type SiemSender } from "./siem/deliver"
import { purgeAuditRowsForTest, tamperAuditRowsForTest } from "./audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("tamper-evident audit", () => {
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const tenantIds = [`aud-a-${token}`, `aud-b-${token}`, `aud-c-${token}`, `aud-d-${token}`, `aud-e-${token}`]
  const [A, B, C, D, E] = tenantIds
  // logAuditStrict types its client as the tenant-scoped extension; a plain client does the same write.
  const write = (tenantId: string | undefined, n: number, client: Pick<PrismaClient, "auditLog"> = db) =>
    logAuditStrict({ tenantId, action: "AUDIT_IT", entity: "Thing", entityId: `e${n}`, oldValue: { n }, newValue: { n: n + 1 } }, client as unknown as Parameters<typeof logAuditStrict>[1])
  const rowsOf = (tenantId: string) => db.auditLog.findMany({ where: { tenantId }, orderBy: { chainSeq: "asc" } })

  beforeAll(async () => {
    await db.tenant.createMany({ data: tenantIds.map((id) => ({ id, slug: id, name: id })) })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId: { in: tenantIds } })
    await db.auditSiemOutbox.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.auditChainHead.deleteMany({ where: { chainKey: { in: tenantIds } } })
    await db.auditPolicy.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.$disconnect()
  })

  describe("append-only", () => {
    it("refuses UPDATE, DELETE and TRUNCATE, whoever asks", async () => {
      await write(A, 1)
      const [row] = await rowsOf(A)
      await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "EDITED" } })).rejects.toThrow(/append-only/)
      await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "newValue" = '{}' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/)
      expect((await rowsOf(A))).toHaveLength(1)
    })

    it("refuses the rewrite of an existing hash column", async () => {
      const [row] = await rowsOf(A)
      await expect(db.auditLog.update({ where: { id: row.id }, data: { rowHash: "0".repeat(64) } })).rejects.toThrow(/append-only/)
    })

    it("refuses to delete a user or tenant that has audit rows (the FK no longer SETs NULL)", async () => {
      const userId = `aud-user-${token}`
      await db.user.create({ data: { id: userId, email: `${userId}@test.invalid`, password: "x", tenantId: B, role: "READONLY" } })
      await logAuditStrict({ tenantId: B, userId, action: "AUDIT_IT", entity: "User" }, db as unknown as Parameters<typeof logAuditStrict>[1])
      await expect(db.user.delete({ where: { id: userId } })).rejects.toMatchObject({ code: "P2003" })
      await expect(db.tenant.delete({ where: { id: B } })).rejects.toMatchObject({ code: "P2003" })
    })

    it("rolls a refused write back with the rest of its transaction", async () => {
      const before = (await rowsOf(C)).length
      await expect(db.$transaction(async (tx) => {
        await write(C, 1, tx)
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = '${C}'`)
      })).rejects.toThrow(/append-only/)
      expect((await rowsOf(C)).length).toBe(before)
    })
  })

  describe("hash chain", () => {
    it("links each row to the one before and ignores hashes the caller supplies", async () => {
      await write(D, 1)
      await db.auditLog.create({
        data: { tenantId: D, action: "AUDIT_IT", entity: "Thing", chainSeq: 99, prevHash: "f".repeat(64), rowHash: "e".repeat(64) },
      })
      await write(D, 3)
      const rows = await rowsOf(D)
      expect(rows.map((r) => r.chainSeq)).toEqual([1, 2, 3])
      expect(rows[0].prevHash).toBe("0".repeat(64))
      expect(rows[1].prevHash).toBe(rows[0].rowHash)
      expect(rows[2].prevHash).toBe(rows[1].rowHash)
      expect(rows[1].rowHash).not.toBe("e".repeat(64))
      expect(await verifyAuditChains(db, { chainKey: D })).toMatchObject({ ok: true, rowsChecked: 3 })
    })

    it("keeps the chain valid under concurrent inserts, in and out of transactions", async () => {
      // 30 autocommit inserts and 10 transactions that hold their row until commit, on two chains, at once.
      const before = { [E]: (await rowsOf(E)).length, [A]: (await rowsOf(A)).length }
      const pool = Array.from({ length: 6 }, () => new PrismaClient())
      try {
        const jobs: Promise<unknown>[] = []
        for (let i = 0; i < 40; i++) {
          const client = pool[i % pool.length]
          const tenantId = i % 2 === 0 ? E : A
          jobs.push(i % 4 === 0
            ? client.$transaction(async (tx) => { await write(tenantId, i, tx); await new Promise((r) => setTimeout(r, 15)) })
            : write(tenantId, i, client))
        }
        await Promise.all(jobs)
      } finally {
        await Promise.all(pool.map((c) => c.$disconnect()))
      }
      for (const [tenantId, added] of [[E, 20], [A, 20]] as const) {
        const expected = before[tenantId] + added
        const seqs = (await rowsOf(tenantId)).map((r) => r.chainSeq)
        expect(seqs).toEqual(Array.from({ length: expected }, (_, i) => i + 1))
        expect(await verifyAuditChains(db, { chainKey: tenantId })).toMatchObject({ ok: true, rowsChecked: expected })
      }
    })

    it("chains rows with no tenant on their own chain", async () => {
      await write(undefined, 1)
      const result = await verifyAuditChains(db, { chainKey: "" })
      expect(result.ok).toBe(true)
      expect(result.rowsChecked).toBeGreaterThan(0)
    })
  })

  describe("tamper detection (a superuser bypassing the triggers)", () => {
    it("finds an edited row", async () => {
      for (let i = 1; i <= 5; i++) await write(C, i)
      const rows = await rowsOf(C)
      await tamperAuditRowsForTest(db, `UPDATE "AuditLog" SET "newValue" = '{"n": 999}' WHERE id = '${rows[2].id}'`)
      const result = await verifyAuditChains(db, { chainKey: C })
      expect(result.ok).toBe(false)
      expect(result.breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: rows[2].chainSeq, auditLogId: rows[2].id })])
    })

    it("finds an edited row whose own hash was recomputed, at the next link", async () => {
      const rows = await rowsOf(C)
      await tamperAuditRowsForTest(db, `UPDATE "AuditLog" a SET "rowHash" = public.audit_log_row_hash(a) WHERE id = '${rows[2].id}'`)
      const result = await verifyAuditChains(db, { chainKey: C })
      expect(result.breaks).toEqual([expect.objectContaining({ kind: "prev_hash_mismatch", chainSeq: rows[3].chainSeq })])
    })

    it("finds a deleted row (a gap) and a cut tail (the head disagrees)", async () => {
      await tamperAuditRowsForTest(db, `DELETE FROM "AuditLog" WHERE "tenantId" = '${D}' AND "chainSeq" = 2`)
      expect((await verifyAuditChains(db, { chainKey: D })).breaks).toEqual([expect.objectContaining({ kind: "seq_gap", chainSeq: 3 })])

      await tamperAuditRowsForTest(db, `DELETE FROM "AuditLog" WHERE "tenantId" = '${E}' AND "chainSeq" = (SELECT max("chainSeq") FROM "AuditLog" WHERE "tenantId" = '${E}')`)
      expect((await verifyAuditChains(db, { chainKey: E })).breaks).toEqual([expect.objectContaining({ kind: "head_mismatch" })])
    })

    it("finds a row written with the trigger off (no chain columns)", async () => {
      const F = `aud-g-${token}`
      await db.tenant.create({ data: { id: F, slug: F, name: F } })
      tenantIds.push(F)
      await write(F, 1)
      await tamperAuditRowsForTest(db, `INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity") VALUES ('loose-${token}', '${F}', 'FORGED', 'Thing')`)
      expect((await verifyAuditChains(db, { chainKey: F })).breaks).toEqual([expect.objectContaining({ kind: "unchained_row", auditLogId: `loose-${token}` })])
    })

    it("walks every chain when none is named, and reports each break once", async () => {
      const all = await verifyAuditChains(db)
      const mine = all.breaks.filter((b) => tenantIds.includes(b.chainKey)).map((b) => b.chainKey).sort()
      expect(mine).toEqual([C, D, E, `aud-g-${token}`].sort())
    })
  })

  describe("the existing-row backfill in the migration", () => {
    it("chains unchained rows in (createdAt, id) order, per tenant, into the heads", async () => {
      const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261029100000_audit_tamper_evident/migration.sql"), "utf8")
      const block = /DO \$\$[\s\S]*?END \$\$;/.exec(sql)?.[0]
      if (!block) throw new Error("the backfill DO block is not in the migration")
      const sentinel = new Error("rollback")
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`DROP INDEX "AuditLog_chain_seq_key"`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "chainSeq" = NULL, "prevHash" = NULL, "rowHash" = NULL`)
        await tx.$executeRawUnsafe(`DELETE FROM "AuditChainHead"`)
        await tx.$executeRawUnsafe(block)
        const result = await verifyAuditChains(tx)
        expect(result.breaks).toEqual([])
        expect(result.rowsChecked).toBeGreaterThan(0)
        throw sentinel
      }, { timeout: 120_000 })).rejects.toBe(sentinel)
    }, 180_000)
  })

  describe("SIEM outbox", () => {
    const policy = (tenantId: string, enabled: boolean) =>
      db.auditPolicy.upsert({
        where: { tenantId },
        create: { tenantId, siemEnabled: enabled, siemTransport: "HTTPS_JSON", siemUrl: "https://siem.example.invalid/ingest" },
        update: { siemEnabled: enabled },
      })
    const pending = (tenantId: string) => db.auditSiemOutbox.findMany({ where: { tenantId }, orderBy: { chainSeq: "asc" } })
    // The outbox row is stamped by the database clock; run the worker a minute ahead of it.
    const T = new Date(Date.now() + 60_000)

    it("queues a row only while the lender forwards, in the audit row's transaction", async () => {
      const F = `aud-f-${token}`
      await db.tenant.create({ data: { id: F, slug: F, name: F } })
      tenantIds.push(F)
      await write(F, 1)
      expect(await pending(F)).toHaveLength(0)

      await policy(F, true)
      await write(F, 2)
      await expect(db.$transaction(async (tx) => { await write(F, 3, tx); throw new Error("abort") })).rejects.toThrow("abort")
      const queued = await pending(F)
      expect(queued).toHaveLength(1)
      const [row] = (await rowsOf(F)).slice(-1)
      expect(queued[0]).toMatchObject({ auditLogId: row.id, chainSeq: row.chainSeq, sentAt: null })
    })

    it("ships at least once: a failed batch backs off and is sent again with the same event ids", async () => {
      const F = tenantIds.find((t) => t.startsWith("aud-f-"))!
      const seen: string[][] = []
      let answer = false
      const send: SiemSender = async (_t, events) => { seen.push(events.map((e) => e.eventId)); return answer ? { ok: true, error: null } : { ok: false, error: "down" } }

      await deliverSiemOutbox({ now: T, send })
      const [failed] = await pending(F)
      expect(failed).toMatchObject({ sentAt: null, lastError: "down", attempts: 1 })
      expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(T.getTime())

      await deliverSiemOutbox({ now: T, send }) // still backing off: not sent again yet
      expect(seen).toHaveLength(1)

      answer = true
      const later = new Date(T.getTime() + 60_000)
      const out = await deliverSiemOutbox({ now: later, send })
      expect(out.sent).toBeGreaterThanOrEqual(1)
      expect(seen[1]).toEqual(seen[0])
      expect((await pending(F))[0].sentAt).not.toBeNull()
    })

    it("leaves the rows of a lender that switched forwarding off", async () => {
      const F = tenantIds.find((t) => t.startsWith("aud-f-"))!
      await write(F, 4)
      await policy(F, false)
      const sent: string[] = []
      await deliverSiemOutbox({ now: new Date(T.getTime() + 120_000), send: async (_t, events) => { sent.push(...events.map((e) => e.eventId)); return { ok: true, error: null } } })
      expect((await pending(F)).filter((r) => r.sentAt === null)).toHaveLength(1)
      expect(sent).toEqual([])
    })
  })

  describe("retention policy", () => {
    it("refuses less than 12 months retained, a hot window under 3 months or over the retention, and plaintext secrets", async () => {
      const create = (data: Record<string, unknown>) => db.auditPolicy.create({ data: { tenantId: A, ...data } as never })
      await expect(create({ retentionMonths: 11 })).rejects.toThrow(/AuditPolicy_retention_floor/)
      await expect(create({ hotMonths: 2 })).rejects.toThrow(/AuditPolicy_hot_window/)
      await expect(create({ retentionMonths: 12, hotMonths: 13 })).rejects.toThrow(/AuditPolicy_hot_window/)
      await expect(create({ siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "http://plain.example.invalid" })).rejects.toThrow(/AuditPolicy_siem_target/)
      await expect(create({ siemSealedToken: "plaintext" })).rejects.toThrow(/AuditPolicy_siem_secrets_sealed/)
    })
  })
})
