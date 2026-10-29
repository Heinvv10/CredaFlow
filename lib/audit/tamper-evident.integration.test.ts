/**
 * Real-Postgres proof of the tamper-evident audit (migrations 20261029100000/100):
 * append-only triggers, a lock-free insert, the chainer under concurrent writers,
 * tamper detection by a superuser who bypasses the triggers, documented redaction,
 * checkpoints and the daily job.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/tamper-evident.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { verifyAuditChains } from "./chain-verify"
import { runChainer } from "./chainer"
import { writeCheckpoints } from "./checkpoint"
import { runAuditChainVerification } from "./verify-job"
import { purgeAuditRowsForTest, tamperAuditRowsForTest } from "./audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("tamper-evident audit", () => {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const ids = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((k) => [k, `aud-${k}-${token}`])) as Record<string, string>
  const tenantIds = Object.values(ids)
  const { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H, i: I } = ids
  // logAuditStrict types its client as the tenant-scoped extension; a plain client does the same write.
  type Writer = Parameters<typeof logAuditStrict>[1]
  const write = (tenantId: string | undefined, n: number, client: unknown = db) =>
    logAuditStrict({ tenantId, action: "AUDIT_IT", entity: "Thing", entityId: `e${n}`, oldValue: { n }, newValue: { n: n + 1 }, userEmail: `p${n}@it.invalid`, ipAddress: "10.0.0.1" }, client as Writer)
  const rows = (tenantId: string) => db.auditLog.findMany({ where: { tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  const links = (tenantId: string) => db.$queryRaw<Array<{ seq: number; auditLogId: string; rowHash: string }>>`SELECT "seq", "auditLogId", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${tenantId} ORDER BY "seq"`
  const chain = (...only: string[]) => runChainer({ db, deep: true, only })
  const verify = (key: string, mode: "full" | "incremental" = "full") => verifyAuditChains(db, { chainKey: key, mode })
  const tamper = (sql: string) => tamperAuditRowsForTest(db, sql)
  const tenant = async (label: string) => {
    const id = `aud-${label}-${token}`
    await db.tenant.create({ data: { id, slug: id, name: id } })
    tenantIds.push(id)
    return id
  }

  beforeAll(async () => {
    await db.tenant.createMany({ data: tenantIds.map((id) => ({ id, slug: id, name: id })) })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId: { in: tenantIds } })
    await db.branch.deleteMany({ where: { tenantId: C } })
    await db.user.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await tamper(`DELETE FROM "AuditChainLink" WHERE "chainKey" = ANY('{${tenantIds.join(",")}}')`)
    await db.auditPolicy.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.$disconnect()
  })

  describe("append-only", () => {
    it("refuses UPDATE, DELETE and TRUNCATE on AuditLog, whoever asks", async () => {
      await write(A, 1)
      const [row] = await rows(A)
      await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "EDITED" } })).rejects.toThrow(/append-only/)
      await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "newValue" = '{}' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
      await expect(db.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow(/append-only/)
      expect(await rows(A)).toHaveLength(1)
    })

    it("refuses the redaction shape without the redaction function's flag, and any other change with it", async () => {
      const [row] = await rows(A)
      await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "userEmail" = NULL WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/)
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('cf.audit_redaction', 'on', true)`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id = '${row.id}'`)
      })).rejects.toThrow(/append-only/)
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('cf.audit_redaction', 'on', true)`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "userEmail" = 'forged@x.invalid' WHERE id = '${row.id}'`)
      })).rejects.toThrow(/append-only/)
    })

    it("refuses UPDATE, DELETE and TRUNCATE on the links, checkpoints and redactions", async () => {
      await chain(A)
      await writeCheckpoints(db, [A])
      const [row] = await rows(A)
      await db.$executeRaw`SELECT public.audit_log_redact(${row.id}, ARRAY['ipAddress']::text[], 'POPIA erasure request ref 7', 'it-operator')`
      for (const table of ["AuditChainLink", "AuditChainCheckpoint", "AuditRedaction"]) {
        expect(Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = '${A}'`))[0].n), table).toBeGreaterThan(0)
        await expect(db.$executeRawUnsafe(`UPDATE "${table}" SET "tenantId" = "tenantId" WHERE "tenantId" = '${A}'`)).rejects.toThrow(/append-only/)
        await expect(db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = '${A}'`)).rejects.toThrow(/append-only/)
        await expect(db.$executeRawUnsafe(`TRUNCATE "${table}"`)).rejects.toThrow(/append-only/)
      }
    })

    it("refuses to delete a user or tenant that has audit rows (the FK no longer SETs NULL)", async () => {
      const userId = `aud-user-${token}`
      await db.user.create({ data: { id: userId, email: `${userId}@test.invalid`, password: "x", tenantId: B, role: "READONLY" } })
      await logAuditStrict({ tenantId: B, userId, action: "AUDIT_IT", entity: "User" }, db as unknown as Writer)
      await expect(db.user.delete({ where: { id: userId } })).rejects.toMatchObject({ code: "P2003" })
      await expect(db.tenant.delete({ where: { id: B } })).rejects.toMatchObject({ code: "P2003" })
    })

    it("has its foreign keys validated (the second migration ran)", async () => {
      const bad = await db.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conrelid = '"AuditLog"'::regclass AND contype = 'f' AND NOT convalidated`
      expect(bad).toEqual([])
    })
  })

  describe("a lock-free insert", () => {
    it("takes no chain work: a Serializable transaction racing autocommit inserts on the same lender never fails with 40001", async () => {
      const pool = Array.from({ length: 6 }, () => new PrismaClient())
      try {
        const serializable = Array.from({ length: 12 }, (_, i) => pool[i % pool.length].$transaction(async (tx) => {
          // Each transaction does its own write, then audits on the shared lender. With a chain row to read and lock, these conflicted.
          await tx.branch.create({ data: { tenantId: C, name: `b${i}`, code: `ser-${i}` } })
          await write(C, i, tx)
          await new Promise((r) => setTimeout(r, 20))
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }))
        const autocommit = Array.from({ length: 30 }, (_, i) => write(C, 100 + i, pool[i % pool.length]))
        const outcomes = await Promise.allSettled([...serializable, ...autocommit])
        expect(outcomes.filter((o) => o.status === "rejected")).toEqual([])
      } finally {
        await Promise.all(pool.map((c) => c.$disconnect()))
      }
      await chain(C)
      expect((await verify(C)).ok).toBe(true)
    })

    it("leaves no link for a rolled-back transaction", async () => {
      let rolledBack = ""
      await expect(db.$transaction(async (tx) => {
        await write(D, 1, tx)
        rolledBack = (await tx.auditLog.findFirstOrThrow({ where: { tenantId: D } })).id
        throw new Error("abort")
      })).rejects.toThrow("abort")
      await write(D, 2)
      await chain(D)
      const l = await links(D)
      expect(l.map((x) => x.auditLogId)).not.toContain(rolledBack)
      expect(l).toHaveLength(1)
      expect((await verify(D)).ok).toBe(true)
    })

    it("leaves no phantom link for rows ON CONFLICT skipped (createMany skipDuplicates)", async () => {
      const make = (n: number) => ({ id: `dup-${n}-${token}`, tenantId: E, action: "AUDIT_IT", entity: "Thing", entityId: `e${n}` })
      await db.auditLog.createMany({ data: [make(1), make(2), make(3)] })
      await chain(E)
      await db.auditLog.createMany({ data: [make(2), make(3), make(4), make(5)], skipDuplicates: true })
      await chain(E)
      const l = await links(E)
      expect(l.map((x) => x.auditLogId).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `dup-${n}-${token}`))
      expect(l.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5])
      expect(await verify(E)).toMatchObject({ ok: true, rowsChecked: 5 })
    })

    it("links a row committed late though it started early, after the ones that committed before it", async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const slow = db.$transaction(async (tx) => { await write(F, 1, tx); await gate })
      await new Promise((r) => setTimeout(r, 100))
      await write(F, 2)
      await chain(F)
      expect(await links(F)).toHaveLength(1)
      release()
      await slow
      await chain(F)
      const l = await links(F)
      expect(l.map((x) => x.seq)).toEqual([1, 2])
      expect((await verify(F)).ok).toBe(true)
    })

    it("never deadlocks audited writes that take their other locks in opposite order", async () => {
      const [one, two] = [new PrismaClient(), new PrismaClient()]
      const branch = await db.branch.create({ data: { tenantId: C, name: "contended", code: `lock-${token}` } })
      try {
        let audited!: () => void
        const firstAudited = new Promise<void>((r) => { audited = r })
        // T2 locks the branch row, waits for T1 to have audited, then audits. T1 audits, then wants the branch row.
        // With a lock held from the audit insert to commit, T1 and T2 would wait on each other.
        const t2 = two.$transaction(async (tx) => {
          await tx.branch.update({ where: { id: branch.id }, data: { name: "two" } })
          await firstAudited
          await write(C, 201, tx)
        })
        await new Promise((r) => setTimeout(r, 50))
        const t1 = one.$transaction(async (tx) => {
          await write(C, 200, tx)
          audited()
          await tx.branch.update({ where: { id: branch.id }, data: { name: "one" } })
        })
        const outcomes = await Promise.allSettled([t1, t2])
        expect(outcomes.filter((o) => o.status === "rejected")).toEqual([])
      } finally {
        await Promise.all([one.$disconnect(), two.$disconnect()])
      }
    })
  })

  describe("the chainer", () => {
    it("keeps the chain valid under 50 concurrent writers and two concurrent chainers, linking each row exactly once", async () => {
      const pool = Array.from({ length: 6 }, () => new PrismaClient())
      try {
        const writers = Array.from({ length: 50 }, (_, i) => (i % 5 === 0
          ? pool[i % pool.length].$transaction(async (tx) => { await write(G, i, tx); await new Promise((r) => setTimeout(r, 10)) })
          : write(G, i, pool[i % pool.length])))
        const chainers = Array.from({ length: 6 }, async () => { for (let n = 0; n < 4; n++) { await chain(G); await new Promise((r) => setTimeout(r, 15)) } })
        await Promise.all([...writers, ...chainers])
      } finally {
        await Promise.all(pool.map((c) => c.$disconnect()))
      }
      await chain(G)
      const l = await links(G)
      expect(l.map((x) => x.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
      expect(new Set(l.map((x) => x.auditLogId)).size).toBe(50)
      expect(await verify(G)).toMatchObject({ ok: true, rowsChecked: 50, pendingUnchained: 0 })
    })

    it("chains a lender's history from its first row, however old (the first run is the backfill)", async () => {
      const old = new Date(Date.now() - 10 * 86_400_000)
      await db.auditLog.createMany({ data: [1, 2, 3].map((n) => ({ id: `old-${n}-${token}`, tenantId: H, action: "AUDIT_IT", entity: "Thing", createdAt: new Date(old.getTime() + n) })) })
      await write(H, 9)
      await chain(H)
      expect((await links(H)).map((x) => x.auditLogId.startsWith("old-"))).toEqual([true, true, true, false])
      expect(await verify(H)).toMatchObject({ ok: true, rowsChecked: 4 })
    })

    it("puts rows with no tenant on their own chain", async () => {
      await write(undefined, 1)
      const [row] = await db.auditLog.findMany({ where: { tenantId: null, entityId: "e1" }, orderBy: { createdAt: "desc" }, take: 1 })
      await runChainer({ db, deep: true, only: [""] })
      const [l] = await db.$queryRaw<Array<{ chainKey: string; tenantId: string | null }>>`SELECT "chainKey", "tenantId" FROM "AuditChainLink" WHERE "auditLogId" = ${row.id}`
      expect(l).toEqual({ chainKey: "", tenantId: null })
    })
  })

  describe("tamper detection (a superuser bypassing the triggers)", () => {
    const seed = async (tenant: string, n: number) => {
      for (let i = 1; i <= n; i++) await write(tenant, i)
      await chain(tenant)
      return rows(tenant)
    }

    it("finds an edited row, and a row whose personal data was nulled without the redaction function", async () => {
      const r = await seed(I, 5)
      await tamper(`UPDATE "AuditLog" SET "newValue" = '{"n": 999}' WHERE id = '${r[2].id}'`)
      expect((await verify(I)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 3, auditLogId: r[2].id })])
      await tamper(`UPDATE "AuditLog" SET "newValue" = '{"n": ${(r[2].newValue as { n: number }).n}}' WHERE id = '${r[2].id}'`)
      expect((await verify(I)).ok).toBe(true)
      await tamper(`UPDATE "AuditLog" SET "userEmail" = NULL WHERE id = '${r[4].id}'`)
      expect((await verify(I)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 5 })])
    })

    // Every column the link hashes: editing any one of them, behind the triggers, breaks the link.
    const COLUMNS: Array<[string, string]> = [
      ["tenantId", `"tenantId" = '__OTHER__'`],
      ["userId", `"userId" = NULL`],
      ["action", `"action" = 'EDITED'`],
      ["entity", `"entity" = 'EDITED'`],
      ["entityId", `"entityId" = 'edited'`],
      ["createdAt", `"createdAt" = "createdAt" + interval '1 second'`],
      ["userEmail", `"userEmail" = 'edited@it.invalid'`],
      ["ipAddress", `"ipAddress" = '10.9.9.9'`],
      ["oldValue", `"oldValue" = '{"n": -1}'`],
      ["newValue", `"newValue" = '{"n": -1}'`],
    ]
    it.each(COLUMNS)("finds an edit of %s", async (column, assignment) => {
      const t = await tenant(`col-${column.toLowerCase()}`)
      const userId = `aud-u-${column}-${token}`
      await db.user.create({ data: { id: userId, email: `${userId}@test.invalid`, password: "x", tenantId: t, role: "READONLY" } })
      for (let i = 1; i <= 3; i++) await logAuditStrict({ tenantId: t, userId, action: "AUDIT_IT", entity: "Thing", entityId: `e${i}`, oldValue: { n: i }, newValue: { n: i + 1 }, userEmail: `p${i}@it.invalid`, ipAddress: "10.0.0.1" }, db as unknown as Writer)
      await chain(t)
      expect((await verify(t)).ok).toBe(true)
      const [target] = await rows(t)
      await tamper(`UPDATE "AuditLog" SET ${assignment.replace("__OTHER__", A)} WHERE id = '${target.id}'`)
      const { breaks } = await verify(t)
      expect(breaks, column).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 1, auditLogId: target.id })])
    })

    it("finds an edited link hash, a deleted link (gap) and a forged replacement link", async () => {
      const r = await seed(await tenant("lh"), 4)
      const key = r[0].tenantId as string
      await tamper(`UPDATE "AuditChainLink" SET "rowHash" = '${"f".repeat(64)}' WHERE "auditLogId" = '${r[1].id}'`)
      expect((await verify(key)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 })])

      const gap = await seed(await tenant("gap"), 4)
      await tamper(`DELETE FROM "AuditChainLink" WHERE "auditLogId" = '${gap[1].id}'`)
      expect((await verify(gap[0].tenantId as string)).breaks).toEqual([expect.objectContaining({ kind: "seq_gap", chainSeq: 3 })])

      // Without AUDIT_CHAIN_KEY a forged link cannot carry a valid hash.
      const forged = await seed(await tenant("forge"), 3)
      await tamper(`DELETE FROM "AuditChainLink" WHERE "auditLogId" = '${forged[1].id}'`)
      await tamper(`INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash")
        SELECT '${forged[0].tenantId}', 2, '${forged[1].id}', '${forged[0].tenantId}', "rowHash", encode(sha256('guess'), 'hex') FROM "AuditChainLink" WHERE "auditLogId" = '${forged[0].id}'`)
      expect((await verify(forged[0].tenantId as string)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 })])
    })

    it("finds a deleted audit row", async () => {
      const r = await seed(await tenant("del"), 3)
      await tamper(`DELETE FROM "AuditLog" WHERE id = '${r[1].id}'`)
      expect((await verify(r[0].tenantId as string)).breaks).toEqual([expect.objectContaining({ kind: "row_missing", chainSeq: 2, auditLogId: r[1].id })])
    })

    it("finds a row older than the chainer's lookback that was never linked", async () => {
      const K = await tenant("k")
      await seed(K, 2)
      await tamper(`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "createdAt") VALUES ('loose-${token}', '${K}', 'FORGED', 'Thing', now() - interval '3 days')`)
      expect((await verify(K)).breaks).toEqual([expect.objectContaining({ kind: "unchained_row", auditLogId: `loose-${token}` })])
    })
  })

  describe("checkpoints", () => {
    it("starts an incremental walk at the latest checkpoint, detects a cut tail and a forged checkpoint, and a full walk still sees what is before it", async () => {
      const L = await tenant("l")
      for (let i = 1; i <= 6; i++) await write(L, i)
      const first = await runAuditChainVerification({ db, mode: "full", only: [L] })
      expect(first.breaks.filter((b) => b.chainKey === L)).toEqual([])
      expect(first.verifiedKeys).toContain(L)
      const [cp] = await db.$queryRaw<Array<{ seq: number; rowHash: string }>>`SELECT "seq", "rowHash" FROM "AuditChainCheckpoint" WHERE "chainKey" = ${L} ORDER BY "seq" DESC LIMIT 1`
      expect(cp.seq).toBeGreaterThanOrEqual(6)
      expect((await db.auditLog.findMany({ where: { tenantId: L, action: "AUDIT_CHAIN_VERIFIED" } })).length).toBe(1)

      const r = await rows(L)
      for (let i = 7; i <= 9; i++) await write(L, i)
      await chain(L)
      expect(await verify(L, "incremental")).toMatchObject({ ok: true, rowsChecked: 4 }) // the 3 new rows and the job's own VERIFIED row

      // Edited before the checkpoint: the incremental walk does not re-read it, the full walk does.
      await tamper(`UPDATE "AuditLog" SET "newValue" = '{"n": 1}' WHERE id = '${r[0].id}'`)
      expect((await verify(L, "incremental")).ok).toBe(true)
      expect((await verify(L, "full")).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 1 })])
      await tamper(`UPDATE "AuditLog" SET "newValue" = '{"n": 2}' WHERE id = '${r[0].id}'`)

      // The link a checkpoint names changed, or the chain cut back past it.
      await tamper(`INSERT INTO "AuditChainCheckpoint" ("id", "chainKey", "tenantId", "seq", "rowHash", "hmac") VALUES ('forged-${token}', '${L}', '${L}', 9, '${"1".repeat(64)}', '${"2".repeat(64)}')`)
      expect((await verify(L, "incremental")).breaks).toEqual([expect.objectContaining({ kind: "checkpoint_invalid" })])
      await tamper(`DELETE FROM "AuditChainCheckpoint" WHERE id = 'forged-${token}'`)
      await tamper(`DELETE FROM "AuditChainLink" WHERE "chainKey" = '${L}' AND "seq" > ${cp.seq - 1}`)
      expect((await verify(L, "incremental")).breaks).toEqual([expect.objectContaining({ kind: "checkpoint_mismatch" })])
      expect((await verify(L, "full")).breaks).toEqual([expect.objectContaining({ kind: "checkpoint_mismatch" })])
    })

    it("the daily job records a break and writes no checkpoint for a chain that failed", async () => {
      const M = await tenant("m")
      for (let i = 1; i <= 3; i++) await write(M, i)
      await chain(M)
      const [row] = await rows(M)
      await tamper(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id = '${row.id}'`)
      const job = await runAuditChainVerification({ db, mode: "full", only: [M] })
      expect(job.breaks.filter((b) => b.chainKey === M)).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 1 })])
      expect(job.verifiedKeys).not.toContain(M)
      expect(await db.auditLog.count({ where: { tenantId: M, action: "AUDIT_CHAIN_BROKEN" } })).toBe(1)
      expect(await db.$queryRaw`SELECT 1 FROM "AuditChainCheckpoint" WHERE "chainKey" = ${M}`).toEqual([])
    })
  })

  describe("documented redaction (POPIA)", () => {
    let N = ""
    const redact = (id: string, cols: string[], reason = "POPIA erasure request ref 42", op = "it-operator") =>
      db.$executeRaw`SELECT public.audit_log_redact(${id}, ${cols}::text[], ${reason}, ${op})`

    it("nulls the personal data, keeps the chain verifiable, records the digests and writes its own audit row", async () => {
      N = await tenant("n")
      for (let i = 1; i <= 4; i++) await write(N, i)
      await chain(N)
      const [target] = await rows(N)
      await redact(target.id, ["userEmail", "newValue"])
      const after = await db.auditLog.findUniqueOrThrow({ where: { id: target.id } })
      expect(after).toMatchObject({ userEmail: null, newValue: null, ipAddress: "10.0.0.1" })
      expect(after.oldValue).toEqual(target.oldValue)
      expect(await verify(N)).toMatchObject({ ok: true })
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: N, action: "AUDIT_ROW_REDACTED" } })
      expect(audit).toMatchObject({ entityId: target.id, newValue: expect.objectContaining({ columns: ["userEmail", "newValue"], operator: "it-operator" }) })
      await chain(N)
      expect(await verify(N)).toMatchObject({ ok: true, rowsChecked: 5 })

      // Another column later; the same column twice is refused.
      await redact(target.id, ["ipAddress"])
      expect((await verify(N)).ok).toBe(true)
      await expect(redact(target.id, ["ipAddress"])).rejects.toThrow(/already redacted/)
      // Redaction does not hide a later edit of what is left.
      await tamper(`UPDATE "AuditLog" SET "oldValue" = '{"n": 5}' WHERE id = '${target.id}'`)
      expect((await verify(N)).breaks).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 1 })])
    })

    it("refuses a thin reason, an unknown column, a missing row and the immutable NCA quotation row; PUBLIC cannot execute it", async () => {
      await write(N, 20)
      const [row] = await db.auditLog.findMany({ where: { tenantId: N, entityId: "e20" } })
      await expect(redact(row.id, ["userEmail"], "short")).rejects.toThrow(/reason/)
      await expect(redact(row.id, ["action"])).rejects.toThrow(/columns/)
      await expect(redact("no-such-row", ["userEmail"])).rejects.toThrow(/no such audit row/)
      await db.auditLog.create({ data: { id: `nca-${token}`, tenantId: N, action: "ASSET_NCA_QUOTE_ISSUED", entity: "Thing", userEmail: "x@it.invalid" } })
      await expect(redact(`nca-${token}`, ["userEmail"])).rejects.toThrow()
      const [pub] = await db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.proname = 'audit_log_redact' AND a.grantee = 0`
      expect(pub.n).toBe(0)
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
