/**
 * Real-Postgres proof that the SIEM outbox functions, the policy function and redaction trust
 * nothing a caller gives them (migration 20261029100000), called as the WORKER login (the web login
 * is shown to have no access to them in runtime-role.integration.test.ts):
 *   audit_outbox_mark / prune_unsent / purge_sent / lease, audit_policy_save, audit_log_redact.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://<superuser>... \
 *     npx vitest run lib/audit/outbox-functions.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { purgeAuditPolicyForTest, purgeAuditRowsForTest } from "./audit-rows.test-helpers"
import { savePolicy } from "./store"
import { columnDigest } from "./chain-hash"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("the database functions trust nothing they are given", () => {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const owner = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const workerRole = `cf_wf_it_${token}`
  const webRole = `cf_wb_it_${token}`
  const tenantId = `of-${token}`
  const other = `of-o-${token}`
  const actor = `of-u-${token}`
  let worker: PrismaClient
  let web: PrismaClient

  const login = (name: string) => {
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = name
    url.password = "it-password"
    return new PrismaClient({ datasourceUrl: url.toString() })
  }
  const policy = (over: Record<string, unknown> = {}) => ({
    retentionMonths: 12, hotMonths: 3, siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null, siemUrl: "https://siem.example.invalid/ingest",
    siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null, ...over,
  })
  const auditRow = (id = `row-${randomUUID().slice(0, 8)}`, t = tenantId) => owner.auditLog.create({ data: { id, tenantId: t, action: "AUDIT_IT", entity: "Thing", userEmail: "p@it.invalid", ipAddress: "10.0.0.9" } })
  const queued = async () => {
    const r = await auditRow()
    await owner.$executeRaw`INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash") VALUES (${tenantId}, (SELECT COALESCE(max("seq"), 0) + 1 FROM "AuditChainLink" WHERE "chainKey" = ${tenantId}), ${r.id}, ${tenantId}, ${"0".repeat(64)}, ${"1".repeat(64)})`
    return owner.auditSiemOutbox.create({ data: { tenantId, kind: "EVENT", auditLogId: r.id } })
  }
  const mark = (t: string, ids: number[], state: string, error: string | null = null, at = new Date(Date.now() + 60_000), destination = "https://x.invalid", ack: string | null = null) =>
    worker.$queryRaw`SELECT audit_outbox_mark(${t}, ${ids}::int[], ${state}, ${error}, ${at.toISOString()}::timestamp, ${destination}, ${ack})`
  const clear = () => owner.$executeRawUnsafe(`DELETE FROM "AuditSiemOutbox" WHERE "tenantId" = '${tenantId}'`)
  /** The backoff of a row has elapsed (the database enforces it against its own clock). */
  const elapse = (id: number) => owner.$executeRawUnsafe(`UPDATE "AuditSiemOutbox" SET "nextAttemptAt" = now() - interval '1 second' WHERE id = ${id}`)

  beforeAll(async () => {
    process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64")
    await owner.tenant.createMany({ data: [tenantId, other].map((id) => ({ id, slug: id, name: id })) })
    await owner.user.create({ data: { id: actor, email: `${actor}@it.invalid`, password: "x", tenantId, role: "SUPER_ADMIN" } })
    for (const [name, grant] of [[workerRole, "audit_grant_worker"], [webRole, "audit_grant_web"]] as const) {
      await owner.$executeRawUnsafe(`CREATE ROLE "${name}" LOGIN PASSWORD 'it-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
      await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${name}"`)
      await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${name}"`)
      await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${name}"`)
      await owner.$executeRawUnsafe(`SELECT ${grant}('${name}')`)
    }
    worker = login(workerRole)
    web = login(webRole)
    await savePolicy(web, tenantId, policy(), { id: actor })
  })

  afterAll(async () => {
    await Promise.all([worker?.$disconnect(), web?.$disconnect()])
    await purgeAuditPolicyForTest(owner, [tenantId, other])
    await purgeAuditRowsForTest(owner, { tenantId: { in: [tenantId, other] } })
    await owner.user.deleteMany({ where: { id: actor } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, other] } } })
    for (const name of [workerRole, webRole]) {
      await owner.$executeRawUnsafe(`DROP OWNED BY "${name}"`).catch(() => undefined)
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`)
    }
    await owner.$disconnect()
  })

  describe("audit_outbox_mark", () => {
    it("will not mark another lender's entries, an unknown state, or an entry that does not exist", async () => {
      await clear()
      const row = await queued()
      await expect(mark(other, [row.id], "sent")).rejects.toThrow(/not all rows are this lender/)
      await expect(mark(tenantId, [row.id], "bogus")).rejects.toThrow(/unknown state/)
      await expect(mark(tenantId, [row.id, 999999999], "sent")).rejects.toThrow(/not all rows are this lender/)
      expect(await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ sentAt: null, deadAt: null, attempts: 0 })
    })

    it("will not mark an entry whose backoff has not elapsed, and only schedules a retry in the future (within two hours)", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() - 1000))).rejects.toThrow(/in the future/)
      await expect(mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 3 * 3_600_000))).rejects.toThrow(/in the future/)
      await mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 30_000))
      expect(await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attempts: 1 })
      // Backing off: neither another retry, nor sent, nor dead, until the window has elapsed.
      for (const state of ["retry", "sent", "dead"]) await expect(mark(tenantId, [row.id], state, "siem_unavailable", new Date(Date.now() + 30_000)), state).rejects.toThrow(/still backing off/)
      await elapse(row.id)
      await mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 60_000))
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(2)
    })

    it("will not give a row up without three attempts that each waited out their backoff, nor without a reason", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "dead", "siem_rejected")).rejects.toThrow(/before three attempts/)
      await expect(mark(tenantId, [row.id], "dead", null)).rejects.toThrow(/needs a reason/)
      await expect(mark(tenantId, [row.id], "dead", "row_missing")).rejects.toThrow(/before three attempts/) // its AuditLog row exists
      for (let attempt = 1; attempt <= 2; attempt++) {
        await mark(tenantId, [row.id], "retry", "siem_rejected", new Date(Date.now() + 30_000))
        await expect(mark(tenantId, [row.id], "dead", "siem_rejected")).rejects.toThrow(/backing off/)
        await elapse(row.id)
      }
      await mark(tenantId, [row.id], "dead", "siem_rejected")
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).deadAt).not.toBeNull()
    })

    it("gives a row up as row_missing only when the AuditLog row itself is gone", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "dead", "row_missing")).rejects.toThrow(/before three attempts/)
      // The audit row vanishes (behind the triggers): now it is true.
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = '${row.auditLogId}'`)
      })
      await mark(tenantId, [row.id], "dead", "row_missing")
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).deadAt).not.toBeNull()
    })

    it("stamps sent with the database clock and leaves a receipt naming the destination and the SIEM's ack; an entry cannot be marked sent twice", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "sent", null, new Date(), " ")).rejects.toThrow(/names its destination/)
      await mark(tenantId, [row.id], "sent", null, new Date("2001-01-01T00:00:00Z"), "https://siem.example.invalid", "req-123")
      const sent = await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })
      expect(sent.sentAt!.getUTCFullYear()).toBeGreaterThan(2020) // the caller's time was ignored
      expect(await owner.auditSiemDelivery.findMany({ where: { outboxId: row.id } })).toEqual([
        expect.objectContaining({ tenantId, kind: "EVENT", destination: "https://siem.example.invalid", ackId: "req-123" }),
      ])
      await expect(mark(tenantId, [row.id], "sent")).rejects.toThrow(/not all rows are this lender/)
      await expect(owner.$executeRawUnsafe(`DELETE FROM "AuditSiemDelivery"`)).rejects.toThrow(/append-only/)
    })
  })

  describe("prune, purge and the lease", () => {
    it("prune refuses while the lender forwards, and while the policy row is gone with its history saying forwarding was on", async () => {
      await expect(worker.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`).rejects.toThrow(/is forwarding/)
      // A lender that never had a policy row: nothing in its history, so nothing forbids it.
      expect(await worker.$queryRaw`SELECT audit_outbox_prune_unsent(${other})`).toEqual([{ audit_outbox_prune_unsent: 0 }])
      // Delete the row behind the trigger (a superuser would have to): the history still says forwarding was on.
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`UPDATE "AuditPolicy" SET "siemEnabled" = false WHERE "tenantId" = '${tenantId}'`)
      })
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`DELETE FROM "AuditPolicy" WHERE "tenantId" = '${tenantId}'`)
      })
      await expect(worker.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`).rejects.toThrow(/history says forwarding was on/)
      await savePolicy(web, tenantId, policy(), { id: actor }) // restore for the rest
    })

    it("purge takes no cutoff and keeps sent entries for seven days", async () => {
      await clear()
      const row = await queued()
      await mark(tenantId, [row.id], "sent")
      await expect(worker.$queryRaw`SELECT audit_outbox_purge_sent(now()::timestamp + interval '1 year')`).rejects.toThrow(/does not exist/)
      await worker.$queryRaw`SELECT audit_outbox_purge_sent()`
      expect(await owner.auditSiemOutbox.count({ where: { id: row.id } })).toBe(1)
      await owner.$executeRawUnsafe(`UPDATE "AuditSiemOutbox" SET "sentAt" = now() - interval '8 days' WHERE id = ${row.id}`).catch(() => undefined)
    })

    it("a lease is held by one deliverer at a time, renewed by its holder, and expires by itself", async () => {
      const take = (holder: string, seconds = 60) => worker.$queryRaw<Array<{ ok: boolean }>>`SELECT audit_outbox_lease(${tenantId}, ${holder}, ${seconds}::int) AS ok`
      expect(await take("a")).toEqual([{ ok: true }])
      expect(await take("b")).toEqual([{ ok: false }])
      expect(await take("a")).toEqual([{ ok: true }])
      await worker.$queryRaw`SELECT audit_outbox_release(${tenantId}, 'b')::text` // not the holder: no effect
      expect(await take("b")).toEqual([{ ok: false }])
      await owner.$executeRawUnsafe(`UPDATE "AuditSiemLease" SET "expiresAt" = now() - interval '1 second' WHERE "tenantId" = '${tenantId}'`)
      expect(await take("b")).toEqual([{ ok: true }])
      await expect(take("b", 0)).rejects.toThrow(/1 to 3600/)
      await worker.$queryRaw`SELECT audit_outbox_release(${tenantId}, 'b')::text`
    })
  })

  describe("audit_policy_save", () => {
    it("is the only way a policy changes: it writes the audit row itself, with the URL as an origin and no secret", async () => {
      await savePolicy(web, tenantId, policy({ siemUrl: "https://siem.example.invalid/ingest/KEY123?token=abc", siemSealedToken: "enc:v1:abc" }), { id: actor, email: "a@it.invalid" }, "10.0.0.5")
      const [row] = await owner.auditLog.findMany({ where: { tenantId, action: "AUDIT_POLICY_UPDATED" }, orderBy: { createdAt: "desc" }, take: 1 })
      expect(row).toMatchObject({ userId: actor, userEmail: "a@it.invalid", ipAddress: "10.0.0.5", entity: "AuditPolicy" })
      expect(JSON.stringify(row.newValue)).not.toContain("KEY123")
      expect(JSON.stringify(row.newValue)).not.toContain("enc:v1")
      expect(row.newValue).toMatchObject({ siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true, siemTokenSet: true })
      await expect(web.$executeRawUnsafe(`UPDATE "AuditPolicy" SET "siemUrl" = 'https://evil.example.invalid' WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow(/permission denied/)
    })

    it("refuses a lender that does not exist, an invalid policy, and a deleted policy row (even for a superuser)", async () => {
      await expect(savePolicy(web, `no-such-${token}`, policy(), { id: actor })).rejects.toThrow(/no such lender/)
      await expect(savePolicy(web, tenantId, policy({ retentionMonths: 6 }), { id: actor })).rejects.toThrow(/retention_floor/)
      await expect(owner.$executeRawUnsafe(`DELETE FROM "AuditPolicy" WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow(/never deleted/)
      await expect(owner.$executeRawUnsafe(`TRUNCATE "AuditPolicy"`)).rejects.toThrow(/never deleted/)
    })

    it("stamps the queued backlog with the old destination in the same transaction, when forwarding moves or stops", async () => {
      await savePolicy(web, tenantId, policy({ siemUrl: "https://old.example.invalid/ingest" }), { id: actor })
      await clear()
      const a = await queued()
      const b = await queued()
      await savePolicy(web, tenantId, policy({ siemUrl: "https://new.example.invalid/ingest" }), { id: actor })
      const stamped = await owner.auditSiemOutbox.findMany({ where: { id: { in: [a.id, b.id] } } })
      expect(stamped.map((o) => (o.targetSnapshot as { siemUrl: string }).siemUrl)).toEqual(["https://old.example.invalid/ingest", "https://old.example.invalid/ingest"])
      // Switching off with a backlog stamps it too (nothing pruned).
      const c = await queued()
      await savePolicy(web, tenantId, policy({ siemEnabled: false, siemUrl: "https://new.example.invalid/ingest" }), { id: actor })
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: c.id } })).targetSnapshot).toMatchObject({ siemUrl: "https://new.example.invalid/ingest" })
      expect(await worker.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`).toEqual([{ audit_outbox_prune_unsent: 0 }])
      await savePolicy(web, tenantId, policy(), { id: actor })
    })
  })

  describe("redaction needs the redaction role, not a session setting", () => {
    it("is not unlocked by the old session flag, by a role that is not audit_redactor, or by a redaction row the app could not write", async () => {
      const r = await auditRow()
      await expect(web.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('cf.audit_redaction', 'on', true)`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "userEmail" = NULL WHERE id = '${r.id}'`)
      })).rejects.toThrow(/permission denied/)
      await expect(web.$executeRawUnsafe(`SET ROLE audit_redactor`)).rejects.toThrow(/permission denied/)
      await expect(web.$executeRawUnsafe(`INSERT INTO "AuditRedaction" ("id", "auditLogId", "columns", "userEmailDigest", "ipAddressDigest", "oldValueDigest", "newValueDigest", "reason", "operator") VALUES ('x', '${r.id}', '{userEmail}', '-', '-', '-', '-', 'a reason here', 'x')`)).rejects.toThrow(/permission denied/)
    })

    it("lets even the redactor role null a column only where a redaction row recorded its digest", async () => {
      const t = await auditRow()
      const nulling = (col: string) => owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE audit_redactor`)
        await tx.$executeRawUnsafe(`UPDATE "AuditLog" SET "${col}" = NULL WHERE id = '${t.id}'`)
      })
      await expect(nulling("userEmail")).rejects.toThrow(/append-only/)
      const digests = { ipAddress: columnDigest("ipAddress", "10.0.0.9") }
      await owner.$executeRaw`SELECT public.audit_log_redact(${t.id}, ARRAY['ipAddress']::text[], 'POPIA erasure request ref 8', 'it-operator', ${JSON.stringify(digests)}::jsonb)`
      expect(await owner.auditLog.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ ipAddress: null, userEmail: "p@it.invalid" })
      await expect(nulling("userEmail")).rejects.toThrow(/append-only/)
    })

    it("demands a keyed digest (64 hex) for every column it removes, and keeps only that, never an unkeyed hash", async () => {
      const t = await auditRow()
      const redact = (cols: string[], digests: Record<string, string>) =>
        owner.$executeRaw`SELECT public.audit_log_redact(${t.id}, ${cols}::text[], 'POPIA erasure request ref 9', 'it-operator', ${JSON.stringify(digests)}::jsonb)`
      await expect(redact(["userEmail"], {})).rejects.toThrow(/keyed digest/)
      await expect(redact(["userEmail"], { userEmail: "short" })).rejects.toThrow(/keyed digest/)
      await redact(["userEmail"], { userEmail: columnDigest("userEmail", "p@it.invalid") })
      const [kept] = await owner.auditRedaction.findMany({ where: { auditLogId: t.id } })
      const unkeyed = (await owner.$queryRaw<Array<{ h: string }>>`SELECT encode(sha256(convert_to('p@it.invalid', 'UTF8')), 'hex') AS h`)[0].h
      expect(kept.userEmailDigest).not.toBe(unkeyed)
      expect(kept.userEmailDigest).toBe(columnDigest("userEmail", "p@it.invalid"))
    })
  })
})
