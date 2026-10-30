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
import { ddl } from "./roles.test-helpers"
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
  const policy = (over: Record<string, unknown> = {}) => {
    const url = String(over.siemUrl ?? "https://siem.example.invalid/ingest")
    const u = new URL(url)
    return {
      retentionMonths: 12, hotMonths: 3, siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null,
      siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null,
      siemOrigin: u.origin, siemUrlHasPathOrQuery: (u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "", ...over, siemUrl: u.href,
    }
  }
  const auditRow = (id = `row-${randomUUID().slice(0, 8)}`, t = tenantId) => owner.auditLog.create({ data: { id, tenantId: t, action: "AUDIT_IT", entity: "Thing", userEmail: "p@it.invalid", ipAddress: "10.0.0.9" } })
  const queued = async () => {
    const r = await auditRow()
    await owner.$executeRaw`INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash") VALUES (${tenantId}, (SELECT COALESCE(max("seq"), 0) + 1 FROM "AuditChainLink" WHERE "chainKey" = ${tenantId}), ${r.id}, ${tenantId}, ${"0".repeat(64)}, ${"1".repeat(64)})`
    return owner.auditSiemOutbox.create({ data: { tenantId, kind: "EVENT", auditLogId: r.id } })
  }
  /** The web login saves a policy the way the application does: in a transaction, which binds the lender first. */
  const saveTx = (t: string, data: Record<string, unknown>, who: { id: string; email?: string | null }, ip?: string) =>
    web.$transaction((tx) => savePolicy(tx as unknown as PrismaClient, t, data, who, ip))
  const HOLDER = "it-holder"
  /** The deliverer holds the lender's lease (as deliverTenant does) before it marks anything. */
  const lease = (t = tenantId, holder = HOLDER, seconds = 600) => worker.$queryRaw`SELECT audit_outbox_lease(${t}, ${holder}, ${seconds}::int)`
  const mark = (t: string, ids: number[], state: string, error: string | null = null, at = new Date(Date.now() + 120_000), ack: string | null = "ack-1", holder = HOLDER) =>
    worker.$queryRaw`SELECT audit_outbox_mark(${t}, ${holder}, ${ids}::int[], ${state}, ${error}, ${at.toISOString()}::timestamp, ${ack})`
  const clear = () => owner.$executeRawUnsafe(`DELETE FROM "AuditSiemOutbox" WHERE "tenantId" = '${tenantId}'`)
  /** The backoff of a row has elapsed (the database enforces it against its own clock). */
  const elapse = (id: number) => owner.$executeRawUnsafe(`UPDATE "AuditSiemOutbox" SET "nextAttemptAt" = now() - interval '1 second' WHERE id = ${id}`)

  beforeAll(async () => {
    process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64")
    await owner.tenant.createMany({ data: [tenantId, other].map((id) => ({ id, slug: id, name: id })) })
    await owner.user.create({ data: { id: actor, email: `${actor}@it.invalid`, password: "x", tenantId, role: "SUPER_ADMIN" } })
    for (const [name, grant] of [[workerRole, "audit_grant_worker"], [webRole, "audit_grant_web"]] as const) {
      await ddl(owner, `CREATE ROLE "${name}" LOGIN PASSWORD 'it-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
      await ddl(owner, `GRANT USAGE ON SCHEMA public TO "${name}"`)
      await ddl(owner, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${name}"`)
      await ddl(owner, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${name}"`)
      await ddl(owner, `SELECT ${grant}('${name}')`)
    }
    worker = login(workerRole)
    web = login(webRole)
    await saveTx(tenantId, policy(), { id: actor })
    await lease()
    await lease(other)
  })

  afterAll(async () => {
    await Promise.all([worker?.$disconnect(), web?.$disconnect()])
    await purgeAuditPolicyForTest(owner, [tenantId, other])
    await purgeAuditRowsForTest(owner, { tenantId: { in: [tenantId, other] } })
    await owner.user.deleteMany({ where: { id: actor } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, other] } } })
    for (const name of [workerRole, webRole]) {
      await ddl(owner, `DROP OWNED BY "${name}"`).catch(() => undefined)
      await ddl(owner, `DROP ROLE IF EXISTS "${name}"`)
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

    it("is for the lease holder only: no lease, an expired lease or another holder is refused", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "sent", null, undefined, "a", "someone-else")).rejects.toThrow(/does not hold/)
      await owner.$executeRawUnsafe(`UPDATE "AuditSiemLease" SET "expiresAt" = now() - interval '1 second' WHERE "tenantId" = '${tenantId}'`)
      await expect(mark(tenantId, [row.id], "sent")).rejects.toThrow(/does not hold/)
      await lease()
      await mark(tenantId, [row.id], "sent")
    })

    it("wants the SIEM's ack id when the entry's own destination is HTTPS, and none when it is syslog, whatever the caller says", async () => {
      await clear()
      const [a, b] = [await queued(), await queued()]
      await expect(mark(tenantId, [a.id], "sent", null, undefined, null)).rejects.toThrow(/acknowledgement id/)
      await expect(mark(tenantId, [a.id], "sent", null, undefined, "  ")).rejects.toThrow(/acknowledgement id/)
      // b was queued for a syslog destination (its stamped snapshot says so): no ack needed, and the caller cannot make it HTTPS or syslog by saying so.
      await owner.auditSiemOutbox.update({ where: { id: b.id }, data: { targetSnapshot: { siemTransport: "SYSLOG_TLS", siemHost: "syslog.example.invalid", siemPort: 6514, siemUrl: null } } })
      await mark(tenantId, [b.id], "sent", null, undefined, null)
      await mark(tenantId, [a.id], "sent", null, undefined, "200@Thu, 29 Oct 2026 22:00:00 GMT")
      expect((await owner.auditSiemDelivery.findMany({ where: { outboxId: { in: [a.id, b.id] } }, orderBy: { outboxId: "asc" } })).map((d) => [d.destination, d.ackId])).toEqual([
        ["https://siem.example.invalid", "200@Thu, 29 Oct 2026 22:00:00 GMT"], ["syslog+tls://syslog.example.invalid:6514", null],
      ])
    })

    it("will not mark an entry whose backoff has not elapsed, and only schedules a retry at least a minute ahead (within two hours)", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() - 1000))).rejects.toThrow(/a minute ahead/)
      await expect(mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 20_000))).rejects.toThrow(/a minute ahead/) // too soon: a rogue loop could burn the attempts
      await expect(mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 3 * 3_600_000))).rejects.toThrow(/a minute ahead/)
      await mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 90_000))
      expect(await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ attempts: 1 })
      // Backing off: neither another retry, nor sent, nor dead, until the window has elapsed.
      for (const state of ["retry", "sent", "dead"]) await expect(mark(tenantId, [row.id], state, "siem_unavailable", new Date(Date.now() + 90_000)), state).rejects.toThrow(/still backing off/)
      await elapse(row.id)
      await mark(tenantId, [row.id], "retry", "siem_unavailable", new Date(Date.now() + 120_000))
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(2)
    })

    it("will not give a row up without three attempts that each waited out their backoff, nor without a reason", async () => {
      await clear()
      const row = await queued()
      await expect(mark(tenantId, [row.id], "dead", "siem_rejected")).rejects.toThrow(/before three attempts/)
      await expect(mark(tenantId, [row.id], "dead", null)).rejects.toThrow(/needs a reason/)
      await expect(mark(tenantId, [row.id], "dead", "row_missing")).rejects.toThrow(/before three attempts/) // its AuditLog row exists
      for (let attempt = 1; attempt <= 2; attempt++) {
        await mark(tenantId, [row.id], "retry", "siem_rejected", new Date(Date.now() + 90_000))
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

    it("stamps sent with the database clock and leaves a receipt naming the entry's OWN destination (an origin, from the policy or the snapshot it carries) and the SIEM's ack; an entry cannot be marked sent twice", async () => {
      await clear()
      await saveTx(tenantId, policy({ siemUrl: "https://siem.example.invalid/ingest/KEY123?token=abc" }), { id: actor })
      const row = await queued()
      await mark(tenantId, [row.id], "sent", null, new Date("2001-01-01T00:00:00Z"), "req-123")
      const sent = await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: row.id } })
      expect(sent.sentAt!.getUTCFullYear()).toBeGreaterThan(2020) // the caller's time was ignored
      expect(await owner.auditSiemDelivery.findMany({ where: { outboxId: row.id } })).toEqual([
        expect.objectContaining({ tenantId, kind: "EVENT", destination: "https://siem.example.invalid", ackId: "req-123" }), // no path, no query
      ])
      // The function has no destination argument any more.
      await expect(worker.$queryRaw`SELECT audit_outbox_mark(${tenantId}, ${HOLDER}, ARRAY[1]::int[], 'sent', NULL, now()::timestamp, 'https://evil.invalid', 'x')`).rejects.toThrow(/does not exist/)
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
      await saveTx(tenantId, policy(), { id: actor }) // restore for the rest
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
      await worker.$queryRaw`SELECT audit_outbox_release(${tenantId}, ${HOLDER})::text`
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
      await saveTx(tenantId, policy({ siemUrl: "https://siem.example.invalid/ingest/KEY123?token=abc", siemSealedToken: "enc:v1:abc" }), { id: actor, email: "a@it.invalid" }, "10.0.0.5")
      const [row] = await owner.auditLog.findMany({ where: { tenantId, action: "AUDIT_POLICY_UPDATED" }, orderBy: { createdAt: "desc" }, take: 1 })
      expect(row).toMatchObject({ userId: actor, userEmail: "a@it.invalid", ipAddress: "10.0.0.5", entity: "AuditPolicy" })
      expect(JSON.stringify(row.newValue)).not.toContain("KEY123")
      expect(JSON.stringify(row.newValue)).not.toContain("enc:v1")
      expect(row.newValue).toMatchObject({ siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true, siemTokenSet: true })
      await expect(web.$executeRawUnsafe(`UPDATE "AuditPolicy" SET "siemUrl" = 'https://evil.example.invalid' WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow(/permission denied/)
    })

    it("refuses an actor who is not a user of the lender", async () => {
      await expect(saveTx(tenantId, policy(), { id: `nobody-${token}` })).rejects.toThrow(/actor must be a user of this lender/)
      const stranger = await owner.user.create({ data: { id: `of-s-${token}`, email: `of-s-${token}@it.invalid`, password: "x", tenantId: other, role: "SUPER_ADMIN" } })
      await expect(saveTx(tenantId, policy(), { id: stranger.id })).rejects.toThrow(/actor must be a user of this lender/)
      await owner.user.delete({ where: { id: stranger.id } })
    })

    it("acts only for the lender the session is bound to, and refuses a session bound to none (a route that forgets or mixes up the lender fails)", async () => {
      const data = JSON.stringify({ ...policy(), siemUrl: "https://siem.example.invalid/ingest" })
      const raw = (bind: string | null, tenant = tenantId) => web.$transaction(async (tx) => {
        if (bind !== null) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${bind}, true)`
        await tx.$queryRaw`SELECT audit_policy_save(${tenant}, ${data}::jsonb, ${actor}, NULL, NULL)`
      })
      const status = (bind: string | null, tenant = tenantId) => web.$transaction(async (tx) => {
        if (bind !== null) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${bind}, true)`
        await tx.$queryRaw`SELECT * FROM audit_chain_status(${tenant})`
      })
      for (const call of [raw, status]) {
        await expect(call(null)).rejects.toThrow(/not bound to a lender/)
        await expect(call(other)).rejects.toThrow(/bound to another lender/)
        await expect(call(tenantId, "")).rejects.toThrow(/a lender is required|bound to another lender/)
      }
      await expect(status(tenantId)).resolves.toBeUndefined()
      await expect(raw(tenantId)).resolves.toBeUndefined()
      // Through the application's helpers the lender is bound for it, so a plain client (no transaction) fails closed.
      await expect(savePolicy(web as never, tenantId, policy(), { id: actor })).rejects.toThrow(/not bound to a lender/)
    })

    it("checks the URL against the origin the application parsed: a disagreement, a backslash or a control character is refused", async () => {
      const bad = (over: Record<string, unknown>) => saveTx(tenantId, { ...policy(), ...over }, { id: actor })
      await expect(bad({ siemOrigin: "https://other.example.invalid" })).rejects.toThrow(/URL and its origin disagree/)
      await expect(bad({ siemUrlHasPathOrQuery: false, siemUrl: "https://siem.example.invalid/ingest?token=S", siemOrigin: "https://siem.example.invalid" })).rejects.toThrow(/URL and its origin disagree/)
      await expect(bad({ siemUrl: "https://siem.example.invalid\\@evil.invalid/x?token=S", siemOrigin: "https://siem.example.invalid" })).rejects.toThrow(/siem_url_clean|disagree/)
      await expect(bad({ siemUrl: "https://siem.example.invalid/in\tgest", siemOrigin: "https://siem.example.invalid" })).rejects.toThrow(/siem_url_clean|disagree/)
      // And the table refuses such a URL however it got there.
      await expect(owner.$executeRawUnsafe(`UPDATE "AuditPolicy" SET "siemUrl" = E'https://siem.example.invalid/a\\nb' WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow(/siem_url_clean/)
    })

    it("refuses a lender that does not exist, an invalid policy, and a deleted policy row (even for a superuser)", async () => {
      await expect(saveTx(`no-such-${token}`, policy(), { id: actor })).rejects.toThrow(/no such lender|actor must be a user of this lender/)
      await expect(saveTx(tenantId, policy({ retentionMonths: 6 }), { id: actor })).rejects.toThrow(/retention_floor/)
      await expect(owner.$executeRawUnsafe(`DELETE FROM "AuditPolicy" WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow(/never deleted/)
      await expect(owner.$executeRawUnsafe(`TRUNCATE "AuditPolicy"`)).rejects.toThrow(/never deleted/)
    })

    it("stamps the queued backlog with the old destination in the same transaction, when forwarding moves or stops", async () => {
      await saveTx(tenantId, policy({ siemUrl: "https://old.example.invalid/ingest" }), { id: actor })
      await clear()
      const a = await queued()
      const b = await queued()
      await saveTx(tenantId, policy({ siemUrl: "https://new.example.invalid/ingest" }), { id: actor })
      const stamped = await owner.auditSiemOutbox.findMany({ where: { id: { in: [a.id, b.id] } } })
      expect(stamped.map((o) => (o.targetSnapshot as { siemUrl: string }).siemUrl)).toEqual(["https://old.example.invalid/ingest", "https://old.example.invalid/ingest"])
      // Switching off with a backlog stamps it too (nothing pruned).
      const c = await queued()
      await saveTx(tenantId, policy({ siemEnabled: false, siemUrl: "https://new.example.invalid/ingest" }), { id: actor })
      expect((await owner.auditSiemOutbox.findUniqueOrThrow({ where: { id: c.id } })).targetSnapshot).toMatchObject({ siemUrl: "https://new.example.invalid/ingest" })
      expect(await worker.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`).toEqual([{ audit_outbox_prune_unsent: 0 }])
      await saveTx(tenantId, policy(), { id: actor })
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
