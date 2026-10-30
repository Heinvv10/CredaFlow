/**
 * Real-Postgres proof of the tamper-evident audit (migrations 20261029100000/50/100): append-only triggers, a lock-free insert and the chainer under concurrent writers, backfill and outage.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/tamper-evident.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { resetChainerState, runChainer } from "./chainer"
import { checkpointNow } from "./checkpoint.test-helpers"
import { auditFixture, suite, type Writer } from "./it-fixture.test-helpers"

suite("tamper-evident", () => {
  const fx = auditFixture(["a", "b", "c", "d", "e", "f", "g", "h"])
  const { db, token, write, rows, links, chain, verify, tamper, tenant, redact, ids } = fx
  const { a: A, b: B, c: C, d: D, e: E, f: F, g: G, h: H } = ids
  beforeAll(fx.setup)
  beforeEach(() => resetChainerState())
  afterAll(fx.teardown)

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

    it("does not let the old session flag unlock a redaction-shaped update, even for a superuser: only the redactor role does", async () => {
      await write(A, 11)
      const [row] = await db.auditLog.findMany({ where: { tenantId: A, entityId: "e11" } })
      // A redaction row that DOES record the digest (planted behind the triggers): the flag alone must still not unlock the update.
      await tamper(`INSERT INTO "AuditRedaction" ("id", "auditLogId", "tenantId", "columns", "userEmailDigest", "ipAddressDigest", "oldValueDigest", "newValueDigest", "reason", "operator")
        VALUES ('planted-${token}', '${row.id}', '${A}', '{ipAddress}', '-', '${"a".repeat(64)}', '-', '-', 'planted for the flag test', 'it')`)
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('cf.audit_redaction', 'on', true)`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "ipAddress" = NULL WHERE id = '${row.id}'`)
      })).rejects.toThrow(/append-only/)
      expect((await db.auditLog.findUniqueOrThrow({ where: { id: row.id } })).ipAddress).toBe("10.0.0.1")
      // As the redactor role, a column the row does NOT cover is still refused, the covered one is allowed.
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE audit_redactor`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "userEmail" = NULL WHERE id = '${row.id}'`)
      })).rejects.toThrow(/append-only/)
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE audit_redactor`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "ipAddress" = NULL WHERE id = '${row.id}'`)
      })
    })

    it("refuses UPDATE, DELETE and TRUNCATE on the links, checkpoints and redactions", async () => {
      await chain(A)
      await checkpointNow(db, A)
      const [row] = await rows(A)
      await redact(row.id, ["ipAddress"], "POPIA erasure request ref 7")
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

    /** Plants committed rows with chosen times behind the triggers (the insert trigger would stamp the clock). */
    const plant = (tenantId: string, label: string, count: number, startSecondsAgo: number, stepSeconds: number) =>
      tamper(`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "createdAt")
        SELECT '${label}-' || g || '-${token}-${tenantId}', '${tenantId}', 'AUDIT_IT', 'Thing', 'p' || g, now() - make_interval(secs => ${startSecondsAgo} - g * ${stepSeconds}) FROM generate_series(1, ${count}) g`)
    const shallow = (tenantId: string) => runChainer({ db, mode: "shallow", only: [tenantId] })

    it("bounds a value at 1 MB at insert, whoever writes it: a stub says it was cut and how big it was; a smaller one is untouched", async () => {
      const K = await tenant("bound")
      const big = "a".repeat(3_000_000) // 3 MB of one character: a few KB on disk
      await db.$executeRaw`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "oldValue", "newValue")
        VALUES (${`big-${token}`}, ${K}, 'AUDIT_IT', 'Thing', jsonb_build_object('k', ${big}::text), jsonb_build_object('k', repeat('b', 700000)))`
      const [row] = await db.$queryRaw<Array<{ oldValue: { truncated?: boolean; bytes?: number; k?: string }; newValue: { k?: string } }>>`
        SELECT "oldValue", "newValue" FROM "AuditLog" WHERE id = ${`big-${token}`}`
      expect(row.oldValue).toEqual({ truncated: true, bytes: expect.any(Number) })
      expect(row.oldValue.bytes).toBeGreaterThan(3_000_000)
      expect(row.newValue.k).toHaveLength(700000) // under the bound: kept whole
      expect((await chain(K)).linked).toBe(1)
      expect(await verify(K)).toMatchObject({ ok: true })
    }, 120_000)

    it("stubs a value copied in already compressed (INSERT ... SELECT from another table), whatever its stored size", async () => {
      const K = await tenant("copied")
      await db.$transaction(async (tx) => {
        // 40 MB of text as jsonb, stored compressed in a scratch table: a few KB as stored, 40 MB as text.
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE cf_copy_src ON COMMIT DROP AS SELECT jsonb_build_object('k', repeat('x', 40000000)) AS v`)
        await tx.$executeRawUnsafe(`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "oldValue", "newValue") SELECT 'copied-${token}', '${K}', 'AUDIT_IT', 'Thing', v, v FROM cf_copy_src`)
        const [stored] = await tx.$queryRaw<Array<{ stored: number }>>`SELECT pg_column_size("newValue") AS stored FROM "AuditLog" WHERE id = ${`copied-${token}`}`
        expect(stored.stored).toBeLessThan(1000) // the stub
      }, { timeout: 120_000 })
      const [row] = await db.$queryRaw<Array<{ newValue: { truncated?: boolean; bytes?: number } }>>`SELECT "newValue" FROM "AuditLog" WHERE id = ${`copied-${token}`}`
      expect(row.newValue).toEqual({ truncated: true, bytes: expect.any(Number) })
      expect(row.newValue.bytes).toBeGreaterThan(40_000_000)
      expect((await chain(K)).linked).toBe(1)
    }, 180_000)

    it("refuses an oversized action, entity, entityId, email or address at insert, and the lender's next row still chains", async () => {
      const K = await tenant("oversize")
      const insert = (col: string, len: number) => {
        const base: Record<string, string> = { id: `'big-${col}-${token}'`, tenantId: `'${K}'`, action: `'AUDIT_IT'`, entity: `'Thing'` }
        base[col] = `repeat('x', ${len})`
        return db.$executeRawUnsafe(`INSERT INTO "AuditLog" (${Object.keys(base).map((c) => `"${c}"`).join(", ")}) VALUES (${Object.values(base).join(", ")})`)
      }
      for (const [col, len] of [["action", 1025], ["entity", 1025], ["entityId", 1025], ["userEmail", 1025], ["ipAddress", 65]] as const) {
        await expect(insert(col, len), col).rejects.toThrow(/AuditLog_text_bounded/)
      }
      await write(K, 1)
      expect((await chain(K)).linked).toBe(1)
      expect(await verify(K)).toMatchObject({ ok: true })
    })

    it("hashes every text column in the database: a legacy row whose action is tens of MB (a constraint cannot reach it) still links and the worker only ever gets 64-character hashes", async () => {
      const K = await tenant("legacy")
      await write(K, 1)
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_text_bounded"`) // DDL is transactional: rolled back below
        await tx.$executeRawUnsafe(`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId") VALUES ('legacy-${token}', '${K}', repeat('a', 30000000), repeat('e', 5000), repeat('i', 5000))`)
        const rows = await tx.$queryRaw<Array<Record<string, string>>>`SELECT * FROM audit_chain_unlinked(${K}, 'full', 3600, 500)`
        expect(rows).toHaveLength(2)
        for (const r of rows) for (const k of ["actionSha", "entitySha", "entityIdSha"]) expect(r[k] === null || r[k].length === 64, k).toBe(true)
        const widest = Math.max(...rows.flatMap((r) => Object.values(r).map((v) => (typeof v === "string" ? v.length : 0))))
        expect(widest).toBeLessThanOrEqual(64) // ids, times and hashes only: nothing the size of the row
        throw new Error("rolled back")
      }, { timeout: 180_000 }).catch((e) => { if (!/rolled back/.test(String(e))) throw e })
      const [still] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'AuditLog_text_bounded'`
      expect(still.n).toBe(1)
    }, 240_000)

    it("chains a row with a huge, compressible value without the worker ever receiving it (the database hashes it)", async () => {
      const K = await tenant("huge")
      await write(K, 1)
      // 30 MB of one character: a few KB on disk (TOAST compresses it), 30 MB in memory if it were sent to the worker.
      await tamper(`INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "newValue") VALUES ('huge-${token}', '${K}', 'AUDIT_IT', 'Thing', jsonb_build_object('k', repeat('a', 30000000)))`)
      const [sent] = await db.$queryRaw<Array<{ widest: number; n: number }>>`
        SELECT max(greatest(length("userEmailSha"), length("ipAddressSha"), length("oldValueSha"), length("newValueSha"))) AS widest, count(*)::int AS n
        FROM audit_chain_unlinked(${K}, 'full', 3600, 500)`
      expect(sent).toEqual({ widest: 64, n: 2 })
      expect((await chain(K)).linked).toBe(2)
      expect(await verify(K)).toMatchObject({ ok: true, rowsChecked: 2 })
      // The SIEM's source query replaces a value over 64 KB with a stub instead of sending 30 MB through the worker.
      const [src] = await db.$queryRaw<Array<{ newValue: { truncated?: boolean; bytes?: number } }>>`SELECT "newValue" FROM audit_outbox_sources(ARRAY[${`huge-${token}`}]::text[])`
      expect(src.newValue).toEqual({ truncated: true, bytes: expect.any(Number) })
    }, 120_000)

    it("stamps an audit row with the database clock whatever createdAt the caller sent", async () => {
      await db.auditLog.create({ data: { id: `clock-${token}`, tenantId: H, action: "AUDIT_IT", entity: "Thing", createdAt: new Date("2001-01-01T00:00:00Z") } })
      const row = await db.auditLog.findUniqueOrThrow({ where: { id: `clock-${token}` } })
      expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
    })

    it("chains a lender's history from its first row, however old, in batches of 500 until done (a 2,000-row backfill)", async () => {
      const K = await tenant("backfill")
      await plant(K, "old", 2000, 10 * 86_400, 1) // only old rows: nothing recent to make the chain a candidate by itself
      const started = Date.now()
      const result = await shallow(K) // not the deep pass: a chain with no link yet is chained from its first row anyway
      expect(result.linked).toBe(2000)
      await write(K, 9)
      expect((await shallow(K)).linked).toBe(1)
      const l = await links(K)
      expect(l).toHaveLength(2001)
      expect(l[0].auditLogId.startsWith("old-")).toBe(true)
      expect(l[2000].auditLogId.startsWith("old-")).toBe(false) // the live row is last, after the planted history
      expect(await verify(K)).toMatchObject({ ok: true, rowsChecked: 2001 })
      expect(Date.now() - started).toBeLessThan(60_000)
    })

    it("resumes from the high-water mark after an outage of any length: rows days newer than the last link are found without a deep pass", async () => {
      const K = await tenant("outage")
      await plant(K, "before", 5, 5 * 86_400, 10) // history, 5 days ago
      await chain(K)
      await plant(K, "after", 5, 3 * 86_400, 10) // written during a 3-day outage: older than any 24-hour window
      expect((await shallow(K)).linked).toBe(5)
      expect((await links(K)).map((x) => x.auditLogId.slice(0, 5))).toEqual(["befor", "befor", "befor", "befor", "befor", "after", "after", "after", "after", "after"])
      expect(await verify(K)).toMatchObject({ ok: true, rowsChecked: 10 })
    })

    const deep = (tenantId: string) => runChainer({ db, mode: "deep", only: [tenantId] })

    it("looks seven days back on the deep pass and everywhere only on the full sweep", async () => {
      const K = await tenant("sweeps")
      await plant(K, "now", 3, 60, 5)
      await chain(K)
      await plant(K, "wk", 1, 3 * 86_400, 0) // three days back: the deep pass reaches it
      await plant(K, "old", 1, 30 * 86_400, 0) // thirty days back: only the full sweep does
      expect((await shallow(K)).linked).toBe(0)
      expect((await deep(K)).linked).toBe(1)
      expect((await links(K)).at(-1)?.auditLogId.startsWith("wk-")).toBe(true)
      expect((await deep(K)).linked).toBe(0)
      expect((await chain(K)).linked).toBe(1)
      expect(await verify(K)).toMatchObject({ ok: true, rowsChecked: 5 })
    })

    it("a stalled chain costs one retry budget and no other lender waits behind it; it is then left alone for a while", async () => {
      // "astall" sorts first, so it is the first chain of the pass: everything behind it is what must not wait.
      const [bad, g1, g2] = [await tenant("astall"), await tenant("fine1"), await tenant("fine2")]
      for (const t of [bad, g1, g2]) for (let i = 1; i <= 3; i++) await write(t, i)
      await db.$executeRawUnsafe(`CREATE FUNCTION public.zz_stall() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RAISE EXCEPTION 'stalled'; END $$`)
      await db.$executeRawUnsafe(`CREATE TRIGGER zz_stall BEFORE INSERT ON "AuditChainLink" FOR EACH ROW WHEN (NEW."chainKey" = '${bad}') EXECUTE FUNCTION public.zz_stall()`)
      try {
        const started = Date.now()
        // Without a budget the stalled chain would retry 500, 250 ... 1 (ten attempts of 0.4 s) before the others began.
        const first = await runChainer({ db, mode: "shallow", only: [bad, g1, g2], retryBudgetMs: 1000 })
        expect(first).toMatchObject({ failed: 1, linked: 6, skipped: 0 })
        expect(Date.now() - started).toBeLessThan(3500)
        expect(await links(g1)).toHaveLength(3)
        expect(await links(g2)).toHaveLength(3)
        expect(await links(bad)).toHaveLength(0)
        const again = Date.now()
        expect(await runChainer({ db, mode: "shallow", only: [bad, g1, g2], retryBudgetMs: 1000 })).toMatchObject({ failed: 0, skipped: 1 })
        expect(Date.now() - again).toBeLessThan(1500) // not touched while it backs off
      } finally {
        await db.$executeRawUnsafe(`DROP TRIGGER zz_stall ON "AuditChainLink"`)
        await db.$executeRawUnsafe(`DROP FUNCTION public.zz_stall()`)
      }
    }, 60_000)

    it("takes a chain's lock in the database: a second chainer skips the chain while the first holds it, and the lock needs no advisory lock", async () => {
      const K = await tenant("mutex")
      await write(K, 1)
      await chain(K) // the pass makes the chain's mutex row, committed, as it does in service
      await write(K, 2)
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let held!: () => void
      const holding = new Promise<void>((r) => { held = r })
      const first = db.$transaction(async (tx) => {
        expect((await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT audit_chain_lock(${K}) AS ok`)[0].ok).toBe(true)
        held()
        await gate
      })
      await holding
      const second = await chain(K)
      expect(second).toMatchObject({ linked: 0, busy: 1 })
      expect((await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)[0].n).toBe(0)
      release()
      await first
      expect((await chain(K)).linked).toBe(1)
    })

    it("finds a row that committed long after it was made only on the deep pass, and links it in order of observation", async () => {
      const K = await tenant("late")
      await plant(K, "now", 5, 60, 5)
      await chain(K)
      await plant(K, "slow", 1, 3 * 3600, 0) // made three hours before the mark, committed only now
      expect((await shallow(K)).linked).toBe(0)
      expect((await deep(K)).linked).toBe(1)
      const l = await links(K)
      expect(l).toHaveLength(6)
      expect(l[5].auditLogId.startsWith("slow-")).toBe(true)
      expect(await verify(K)).toMatchObject({ ok: true })
    })

    it("puts rows with no tenant on their own chain", async () => {
      await write(undefined, 1)
      const [row] = await db.auditLog.findMany({ where: { tenantId: null, entityId: "e1" }, orderBy: { createdAt: "desc" }, take: 1 })
      await runChainer({ db, mode: "full", only: [""] })
      const [l] = await db.$queryRaw<Array<{ chainKey: string; tenantId: string | null }>>`SELECT "chainKey", "tenantId" FROM "AuditChainLink" WHERE "auditLogId" = ${row.id}`
      expect(l).toEqual({ chainKey: "", tenantId: null })
    })
  })
})
