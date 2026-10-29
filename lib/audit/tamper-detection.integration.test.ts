/**
 * Real-Postgres proof that tampering behind the triggers (a superuser) is found: edits of every hashed column, links, rows, checkpoints, the daily job and accepted breaks.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://... \
 *     npx vitest run lib/audit/tamper-detection.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { logAuditStrict } from "@/lib/audit"
import { repairHmac } from "./chain-hash"
import { writeCheckpoints } from "./checkpoint"
import { runAuditChainVerification } from "./verify-job"
import { auditFixture, suite, type Writer } from "./it-fixture.test-helpers"

suite("tamper-detection", () => {
  const fx = auditFixture(["a", "i"])
  const { db, token, write, rows, chain, verify, tamper, tenant, ids } = fx
  const { a: A, i: I } = ids
  beforeAll(fx.setup)
  afterAll(fx.teardown)

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
      expect((await verify(key)).breaks).toEqual([
        expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 }), expect.objectContaining({ kind: "prev_hash_mismatch", chainSeq: 3 }),
      ])

      const gap = await seed(await tenant("gap"), 4)
      await tamper(`DELETE FROM "AuditChainLink" WHERE "auditLogId" = '${gap[1].id}'`)
      expect((await verify(gap[0].tenantId as string)).breaks).toEqual([expect.objectContaining({ kind: "seq_gap", chainSeq: 3 })])

      // Without AUDIT_CHAIN_KEY a forged link cannot carry a valid hash.
      const forged = await seed(await tenant("forge"), 3)
      await tamper(`DELETE FROM "AuditChainLink" WHERE "auditLogId" = '${forged[1].id}'`)
      await tamper(`INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash")
        SELECT '${forged[0].tenantId}', 2, '${forged[1].id}', '${forged[0].tenantId}', "rowHash", encode(sha256('guess'), 'hex') FROM "AuditChainLink" WHERE "auditLogId" = '${forged[0].id}'`)
      // The forged link fails, and so does the next one, whose prevHash is the genuine link's: both are reported.
      expect((await verify(forged[0].tenantId as string)).breaks).toEqual([
        expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 }), expect.objectContaining({ kind: "prev_hash_mismatch", chainSeq: 3 }),
      ])
    })

    it("reports every break, not only the first, and one damaged link does not hide another", async () => {
      const r = await seed(await tenant("many"), 6)
      const key = r[0].tenantId as string
      await tamper(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id IN ('${r[1].id}', '${r[4].id}')`)
      expect((await verify(key)).breaks).toEqual([
        expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 }), expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 5 }),
      ])
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

  describe("an operator accepting a break", () => {
    const accept = (key: string, seq: number, kind: string, reason = "restored from the 03:00 backup, row lost", operator = "it-operator", hmac = repairHmac(key, seq, kind, reason, operator)) =>
      db.$executeRaw`SELECT public.audit_chain_accept_break(${key}, ${seq}::int, ${kind}, ${reason}, ${operator}, ${hmac})`

    it("lets verification pass a signed-off break, lists it as accepted, writes its own audit row, and still fails any other", async () => {
      const K = await tenant("repair")
      for (let i = 1; i <= 5; i++) await write(K, i)
      await chain(K)
      const r = await rows(K)
      await tamper(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id IN ('${r[1].id}', '${r[3].id}')`)
      expect((await verify(K)).breaks.map((b) => b.chainSeq)).toEqual([2, 4])

      await accept(K, 2, "row_hash_mismatch")
      const after = await verify(K)
      expect(after.ok).toBe(false)
      expect(after.breaks.map((b) => b.chainSeq)).toEqual([4])
      expect(after.accepted).toEqual([expect.objectContaining({ kind: "row_hash_mismatch", chainSeq: 2 })])
      expect(await db.auditLog.count({ where: { tenantId: K, action: "AUDIT_CHAIN_BREAK_ACCEPTED" } })).toBe(1)

      await accept(K, 4, "row_hash_mismatch")
      expect(await verify(K)).toMatchObject({ ok: true, accepted: [expect.anything(), expect.anything()] })
    })

    it("ignores an acceptance signed without the key, or for another kind or place, and reports the forged record", async () => {
      const K = await tenant("forgedrepair")
      for (let i = 1; i <= 3; i++) await write(K, i)
      await chain(K)
      const [first] = await rows(K)
      await tamper(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id = '${first.id}'`)
      await accept(K, 1, "row_hash_mismatch", "forged by someone without the key", "attacker", "a".repeat(64))
      await accept(K, 1, "seq_gap")
      const result = await verify(K)
      expect(result.ok).toBe(false)
      expect(result.breaks.map((b) => b.kind).sort()).toEqual(["repair_invalid", "row_hash_mismatch"])
      expect(result.accepted).toEqual([])
    })

    it("is refused without a reason, an operator or a signature", async () => {
      const K = await tenant("thinrepair")
      await expect(accept(K, 1, "seq_gap", "short")).rejects.toThrow(/reason/)
      await expect(accept(K, 1, "seq_gap", "a proper reason here", " ")).rejects.toThrow(/operator/)
      await expect(accept(K, 1, "seq_gap", "a proper reason here", "op", "nope")).rejects.toThrow(/signature/)
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
      // The link the checkpoint names is gone: reported, then the chain is walked from the start and its short end is reported too.
      for (const mode of ["incremental", "full"] as const) {
        const { breaks } = await verify(L, mode)
        expect(breaks.length, mode).toBeGreaterThanOrEqual(1)
        expect(breaks.every((b) => b.kind === "checkpoint_mismatch"), mode).toBe(true)
      }
    })

    it("signs what the walk verified, not the head as it is by the time it signs", async () => {
      const T = await tenant("toctou")
      for (let i = 1; i <= 3; i++) await write(T, i)
      await chain(T)
      const walked = await verify(T)
      expect(walked.verifiedHeads).toEqual([{ chainKey: T, seq: 3, rowHash: expect.stringMatching(/^[0-9a-f]{64}$/) }])
      // Two more rows are chained after the walk and before the signing.
      for (let i = 4; i <= 5; i++) await write(T, i)
      await chain(T)
      expect(await writeCheckpoints(db, walked.verifiedHeads)).toBe(1)
      const cps = await db.$queryRaw<Array<{ seq: number }>>`SELECT "seq" FROM "AuditChainCheckpoint" WHERE "chainKey" = ${T}`
      expect(cps).toEqual([{ seq: 3 }])
    })

    it("refuses to sign a link that was swapped after the walk", async () => {
      const T = await tenant("swap")
      for (let i = 1; i <= 3; i++) await write(T, i)
      await chain(T)
      const walked = await verify(T)
      await tamper(`UPDATE "AuditChainLink" SET "rowHash" = '${"e".repeat(64)}' WHERE "chainKey" = '${T}' AND "seq" = 3`)
      await expect(writeCheckpoints(db, walked.verifiedHeads)).rejects.toThrow(/no such link/)
      expect(await db.$queryRaw`SELECT 1 FROM "AuditChainCheckpoint" WHERE "chainKey" = ${T}`).toEqual([])
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
})
