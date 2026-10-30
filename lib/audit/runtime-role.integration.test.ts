/**
 * Real-Postgres proof of the three-login deployment (migration 20261029100000,
 * audit_grant_web / audit_grant_worker / audit_grant_runtime): the WEB login serves requests and
 * can insert and read AuditLog, save the lender's audit policy and read a chain's status, and
 * nothing else; the WORKER login runs the chainer, the verifier and the SIEM delivery through the
 * database's SECURITY DEFINER functions; neither can switch a trigger off, skip triggers with
 * session_replication_role, touch the evidence tables, the outbox or their sequences, or redact.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://<superuser>... \
 *     npx vitest run lib/audit/runtime-role.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { ddl } from "./roles.test-helpers"
import { logAuditStrict } from "@/lib/audit"
import { verifyAuditChains } from "./chain-verify"
import { runChainer } from "./chainer"
import { checkpointNow } from "./checkpoint.test-helpers"
import { auditSetupWarnings } from "./deployment-check"
import { purgeAuditPolicyForTest, purgeAuditRowsForTest } from "./audit-rows.test-helpers"
import { chainStatus, savePolicy } from "./store"
import { deliverSiemOutbox, type SiemSender } from "./siem/deliver"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("the web and worker database logins", () => {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const owner = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const roles = { web: `cf_web_it_${token}`, worker: `cf_wrk_it_${token}`, both: `cf_both_it_${token}` }
  const tenantId = `rt-${token}`
  const other = `rt-o-${token}`
  type Writer = Parameters<typeof logAuditStrict>[1]
  const clients: Record<keyof typeof roles, PrismaClient> = {} as never
  const WORKER_ENV = { AUDIT_CHAIN_KEY: "k".repeat(40), CRON_SCHEDULER: "on", APP_MODE: "all" }
  const WEB_ENV = { CRON_SCHEDULER: "off", APP_MODE: "staff" }

  const login = (name: string) => {
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = name
    url.password = "it-password"
    return new PrismaClient({ datasourceUrl: url.toString() })
  }
  const write = (n: number, client: PrismaClient) =>
    logAuditStrict({ tenantId, action: "AUDIT_IT", entity: "Thing", entityId: `e${n}`, oldValue: { n }, newValue: { n: n + 1 }, userEmail: `p${n}@it.invalid`, ipAddress: "10.0.0.1" }, client as unknown as Writer)
  const denied = (client: PrismaClient, sql: string) =>
    expect(client.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied|must be owner|must be superuser|not permitted/i)

  beforeAll(async () => {
    process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64")
    await owner.tenant.createMany({ data: [tenantId, other].map((id) => ({ id, slug: id, name: id })) })
    // What a deployment gives an application login: everything on the schema (the usual grant), then
    // the audit_grant_* function takes the audit tables and their sequences back.
    for (const name of Object.values(roles)) {
      await ddl(owner, `CREATE ROLE "${name}" LOGIN PASSWORD 'it-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
      await ddl(owner, `GRANT USAGE ON SCHEMA public TO "${name}"`)
      await ddl(owner, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${name}"`)
      await ddl(owner, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${name}"`)
    }
    await owner.$executeRaw`SELECT audit_grant_web(${roles.web})`
    await owner.$executeRaw`SELECT audit_grant_worker(${roles.worker})`
    await owner.$executeRaw`SELECT audit_grant_runtime(${roles.both})`
    for (const key of Object.keys(roles) as Array<keyof typeof roles>) clients[key] = login(roles[key])
  })

  afterAll(async () => {
    await Promise.all(Object.values(clients).map((c) => c.$disconnect()))
    await purgeAuditPolicyForTest(owner, [tenantId, other])
    await purgeAuditRowsForTest(owner, { tenantId: { in: [tenantId, other] } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, other] } } })
    for (const name of Object.values(roles)) {
      await ddl(owner, `DROP OWNED BY "${name}"`).catch(() => undefined)
      await ddl(owner, `DROP ROLE IF EXISTS "${name}"`)
    }
    await owner.$disconnect()
  })

  it("none of them is a superuser, owns an audit table, or can bypass row-level security; the health check is quiet for each in its shape", async () => {
    for (const key of Object.keys(roles) as Array<keyof typeof roles>) {
      const [r] = await clients[key].$queryRaw<Array<{ su: boolean; bypass: boolean; owns: number }>>`
        SELECT r.rolsuper AS su, r.rolbypassrls AS bypass,
               (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
        FROM pg_roles r WHERE r.rolname = current_user`
      expect(r, key).toEqual({ su: false, bypass: false, owns: 0 })
    }
    expect(await auditSetupWarnings(clients.web, WEB_ENV)).toEqual([])
    expect(await auditSetupWarnings(clients.worker, WORKER_ENV)).toEqual([])
    expect(await auditSetupWarnings(clients.both, WORKER_ENV)).toEqual([])
    expect(await auditSetupWarnings(owner, WORKER_ENV)).toEqual(expect.arrayContaining(["audit_runtime_role_owns_tables", "audit_runtime_role_can_write_evidence"]))
    // A single login on a web process holds the worker functions: said so.
    expect(await auditSetupWarnings(clients.both, WEB_ENV)).toEqual(["audit_web_holds_worker_functions"])
  })

  it("insert and read AuditLog, and cannot update, delete or truncate it", async () => {
    for (const key of ["web", "worker"] as const) {
      await write(key === "web" ? 1 : 2, clients[key])
    }
    const rows = await clients.web.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } })
    expect(rows.map((r) => r.entityId)).toEqual(["e1", "e2"])
    for (const key of ["web", "worker"] as const) {
      await denied(clients[key], `UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id = '${rows[0].id}'`)
      await denied(clients[key], `DELETE FROM "AuditLog" WHERE id = '${rows[0].id}'`)
      await denied(clients[key], `TRUNCATE "AuditLog"`)
    }
  })

  it("cannot switch a trigger off, skip triggers, take ownership, or replace a function", async () => {
    for (const key of ["web", "worker"] as const) {
      const c = clients[key]
      await denied(c, `ALTER TABLE "AuditLog" DISABLE TRIGGER ALL`)
      await denied(c, `ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_a_append_only"`)
      await denied(c, `ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_created_at"`)
      await denied(c, `DROP TRIGGER "AuditLog_a_append_only" ON "AuditLog"`)
      await denied(c, `ALTER TABLE "AuditChainLink" DISABLE TRIGGER ALL`)
      await denied(c, `ALTER TABLE "AuditPolicy" DISABLE TRIGGER "AuditPolicy_no_delete"`)
      await denied(c, `SET session_replication_role = replica`)
      await denied(c, `ALTER TABLE "AuditLog" OWNER TO CURRENT_USER`)
      await denied(c, `ALTER FUNCTION audit_chain_append(text, jsonb) OWNER TO CURRENT_USER`)
      await denied(c, `CREATE OR REPLACE FUNCTION audit_chain_append(p_key text, p_links jsonb) RETURNS int LANGUAGE sql AS 'SELECT 0'`)
      await denied(c, `CREATE FUNCTION public.audit_shadow() RETURNS int LANGUAGE sql AS 'SELECT 0'`)
      await denied(c, `ALTER TABLE "AuditLog" DISABLE ROW LEVEL SECURITY`)
    }
  })

  it("have no privilege on the links, checkpoints, redactions, repairs, revisions, receipts, outbox or lease; the policy is read-only", async () => {
    for (const key of ["web", "worker"] as const) {
      const c = clients[key]
      for (const table of ["AuditChainLink", "AuditChainCheckpoint", "AuditRedaction", "AuditChainRepair", "AuditPolicyRevision", "AuditSiemDelivery", "AuditSiemOutbox", "AuditSiemLease", "AuditChainMutex"]) {
        await denied(c, `SELECT 1 FROM "${table}"`)
        await denied(c, `INSERT INTO "${table}" DEFAULT VALUES`)
        const col = table === "AuditChainMutex" ? "chainKey" : "tenantId"
        await denied(c, `UPDATE "${table}" SET "${col}" = "${col}"`)
        await denied(c, `DELETE FROM "${table}"`)
        await denied(c, `TRUNCATE "${table}"`)
      }
      await expect(c.$queryRawUnsafe(`SELECT 1 FROM "AuditPolicy" LIMIT 1`)).resolves.toBeDefined()
      await denied(c, `INSERT INTO "AuditPolicy" ("id", "tenantId", "updatedAt") VALUES ('x', '${tenantId}', now())`)
      await denied(c, `UPDATE "AuditPolicy" SET "siemEnabled" = false`)
      await denied(c, `DELETE FROM "AuditPolicy"`)
    }
  })

  it("have no privilege on the sequences behind the audit tables, so nobody can exhaust them", async () => {
    for (const key of ["web", "worker"] as const) {
      for (const seq of ["AuditSiemOutbox_id_seq", "AuditPolicyRevision_id_seq", "AuditSiemDelivery_id_seq"]) {
        await expect(clients[key].$queryRawUnsafe(`SELECT nextval('"${seq}"')`), `${key} ${seq}`).rejects.toThrow(/permission denied/)
        await expect(clients[key].$queryRawUnsafe(`SELECT setval('"${seq}"', 9223372036854775000)`), `${key} ${seq}`).rejects.toThrow(/permission denied/)
      }
    }
  })

  it("cannot redact or accept a break, and the web login cannot call any worker function", async () => {
    const [row] = await clients.web.auditLog.findMany({ where: { tenantId }, take: 1 })
    for (const key of ["web", "worker", "both"] as const) {
      const c = clients[key]
      await expect(c.$queryRaw`SELECT audit_log_redact(${row.id}, ARRAY['ipAddress']::text[], 'erasure request 12345', 'app', ${JSON.stringify({ ipAddress: "a".repeat(64) })}::jsonb)`).rejects.toThrow(/permission denied/)
      await expect(c.$queryRaw`SELECT audit_chain_accept_break(${tenantId}, 1, 'seq_gap', '', '', '', 'a proper reason here', 'app', ${"b".repeat(64)})`).rejects.toThrow(/permission denied/)
    }
    for (const call of [
      (c: PrismaClient) => c.$queryRaw`SELECT audit_chain_append(${tenantId}, '[]'::jsonb)`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_chain_lock(${tenantId})`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_checkpoint_write(${tenantId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)})`,
      (c: PrismaClient) => c.$queryRaw`SELECT * FROM audit_verify_links(${tenantId}, 0, 10)`,
      (c: PrismaClient) => c.$queryRaw`SELECT * FROM audit_outbox_stream_rows(${tenantId}, 10)`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_outbox_mark(${tenantId}, 'h', ARRAY[1]::int[], 'sent', NULL, now()::timestamp, 'x')`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_outbox_prune_unsent(${tenantId})`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_outbox_purge_sent()`,
      (c: PrismaClient) => c.$queryRaw`SELECT audit_outbox_lease(${tenantId}, 'me', 60)`,
      (c: PrismaClient) => c.$queryRaw`SELECT * FROM audit_delivery_policy(${tenantId})`,
    ]) await expect(call(clients.web)).rejects.toThrow(/permission denied/)
    // The web login's two functions work.
    expect(await clients.web.$transaction((tx) => chainStatus(tx as unknown as PrismaClient, tenantId))).toEqual({ headSeq: 0, checkpointSeq: null, checkpointAt: null })
  })

  it("the worker chains, verifies and checkpoints through the functions, and delivers the SIEM queue", async () => {
    const actorId = (await owner.user.create({ data: { id: `rt-u-${token}`, email: `rt-u-${token}@it.invalid`, password: "x", tenantId, role: "SUPER_ADMIN" } })).id
    const policyId = await clients.web.$transaction((tx) => savePolicy(tx as unknown as PrismaClient, tenantId, {
      retentionMonths: 12, hotMonths: 3, siemEnabled: true, siemTransport: "HTTPS_JSON", siemHost: null, siemPort: null, siemUrl: "https://siem.example.invalid/ingest", siemOrigin: "https://siem.example.invalid", siemUrlHasPathOrQuery: true,
      siemSealedToken: null, siemCaCertPem: null, siemClientCert: null, siemSealedKey: null,
    }, { id: actorId }))
    expect(policyId).toMatch(/^cap_/)
    for (let i = 3; i <= 5; i++) await write(i, clients.web)

    expect(await runChainer({ db: clients.worker, mode: "full", only: [tenantId] })).toMatchObject({ chains: 1, linked: 6 })
    expect(await verifyAuditChains(clients.worker, { chainKey: tenantId, mode: "full" })).toMatchObject({ ok: true, rowsChecked: 6 })
    expect(await checkpointNow(clients.worker, tenantId)).toBe(1)
    expect(await verifyAuditChains(clients.worker, { chainKey: tenantId, mode: "incremental" })).toMatchObject({ ok: true })

    // What the web login may see of it.
    expect(await clients.web.$transaction((tx) => chainStatus(tx as unknown as PrismaClient, tenantId))).toMatchObject({ headSeq: 6, checkpointSeq: 6 })

    const sent: number[] = []
    const send: SiemSender = async (_target, events) => {
      sent.push(...events.flatMap((e) => (e.chain.seq === null ? [] : [e.chain.seq])))
      return { ok: true, error: null, ackId: "ack-1" }
    }
    const result = await deliverSiemOutbox({ db: clients.worker, send, now: new Date(Date.now() + 60_000), only: [tenantId] })
    expect(result.failedTenants).toBe(0)
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 6]) // the anchor (chain position 0 when forwarding began), the six events, the checkpoint
    expect((await owner.auditSiemDelivery.findMany({ where: { tenantId } })).every((d) => d.ackId === "ack-1")).toBe(true)
  })

  it("cannot forge a link or a checkpoint through the functions", async () => {
    const c = clients.worker
    const [head] = await c.$queryRaw<Array<{ seq: number; rowHash: string }>>`SELECT * FROM audit_chain_head(${tenantId})`
    await write(6, clients.web)
    const [fresh] = await c.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 1 })
    const link = (over: Record<string, unknown>) => JSON.stringify([{ seq: head.seq + 1, auditLogId: fresh.id, prevHash: head.rowHash, rowHash: "a".repeat(64), ...over }])
    const append = (links: string, key = tenantId) => c.$queryRaw`SELECT audit_chain_append(${key}, ${links}::jsonb)`

    await expect(append(link({ prevHash: "b".repeat(64) }))).rejects.toThrow(/does not continue the chain/)
    await expect(append(link({ seq: head.seq + 2 }))).rejects.toThrow(/does not continue the chain/)
    await expect(append(link({ auditLogId: "no-such-row" }))).rejects.toThrow(/names no audit row/)
    await expect(append(link({}), other)).rejects.toThrow(/does not continue|names no audit row/)
    await expect(append(link({ rowHash: "short" }))).rejects.toThrow(/malformed rowHash/)
    await expect(c.$queryRaw`SELECT audit_checkpoint_write(${tenantId}, ${head.seq + 5}::int, ${"c".repeat(64)}, ${"d".repeat(64)})`).rejects.toThrow(/no such link/)
    await expect(c.$queryRaw`SELECT audit_checkpoint_write(${tenantId}, ${head.seq}::int, ${"c".repeat(64)}, ${"d".repeat(64)})`).rejects.toThrow(/no such link/)

    // Nothing the refused calls tried is in the chain.
    expect(await runChainer({ db: c, mode: "full", only: [tenantId] })).toMatchObject({ linked: 1 })
    expect(await verifyAuditChains(c, { chainKey: tenantId, mode: "full" })).toMatchObject({ ok: true, rowsChecked: 7 })
  })

  it("leaves the functions' row-level-security bypass behind when they return", async () => {
    await clients.worker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT * FROM audit_chain_head(${tenantId})`
      const [r] = await tx.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.rls_bypass', true) AS v`
      expect(r.v ?? "").not.toBe("on")
    })
  })
})
