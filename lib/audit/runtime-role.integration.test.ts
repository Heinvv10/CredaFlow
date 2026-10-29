/**
 * Real-Postgres proof of the two-login deployment (migration 20261029100000,
 * audit_grant_runtime): the application's role owns nothing, holds INSERT and
 * SELECT on AuditLog, and reaches the evidence tables only through the database's
 * SECURITY DEFINER functions. It cannot switch a trigger off, skip triggers with
 * session_replication_role, write or read a link, checkpoint or outbox row, or
 * redact; and the chainer, verifier and SIEM delivery still work through it.
 *
 *   RUN_DB_IT=1 AUDIT_CHAIN_KEY=<32+ chars> DATABASE_URL=postgresql://<superuser>... \
 *     npx vitest run lib/audit/runtime-role.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { verifyAuditChains } from "./chain-verify"
import { runChainer } from "./chainer"
import { writeCheckpoints } from "./checkpoint"
import { auditSetupWarnings } from "./deployment-check"
import { purgeAuditRowsForTest } from "./audit-rows.test-helpers"
import { deliverSiemOutbox, type SiemSender } from "./siem/deliver"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

suite("the application's database role", () => {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const owner = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const role = `cf_app_it_${token}`
  const tenantId = `rt-${token}`
  const other = `rt-o-${token}`
  type Writer = Parameters<typeof logAuditStrict>[1]
  let app: PrismaClient

  const asApp = () => {
    const url = new URL(process.env.DATABASE_URL as string)
    url.username = role
    url.password = "app-it-password"
    return new PrismaClient({ datasourceUrl: url.toString() })
  }
  const write = (n: number, client: unknown = app) =>
    logAuditStrict({ tenantId, action: "AUDIT_IT", entity: "Thing", entityId: `e${n}`, oldValue: { n }, newValue: { n: n + 1 }, userEmail: `p${n}@it.invalid`, ipAddress: "10.0.0.1" }, client as Writer)
  const denied = (sql: string, client: PrismaClient = app) =>
    expect(client.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied|must be owner|must be superuser|not permitted/i)

  beforeAll(async () => {
    process.env.WABA_ENC_KEY ??= Buffer.alloc(32, 5).toString("base64")
    await owner.tenant.createMany({ data: [tenantId, other].map((id) => ({ id, slug: id, name: id })) })
    // What the deployment gives the application's login: everything on the schema (the usual
    // grant), then audit_grant_runtime takes the evidence tables back.
    await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'app-it-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`)
    await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
    await owner.$executeRaw`SELECT audit_grant_runtime(${role})`
    app = asApp()
  })

  afterAll(async () => {
    await app?.$disconnect()
    await purgeAuditRowsForTest(owner, { tenantId: { in: [tenantId, other] } })
    await owner.auditPolicy.deleteMany({ where: { tenantId: { in: [tenantId, other] } } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, other] } } })
    await owner.$executeRawUnsafe(`REASSIGN OWNED BY "${role}" TO CURRENT_USER`).catch(() => undefined)
    await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`).catch(() => undefined)
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`)
    await owner.$disconnect()
  })

  it("is not a superuser, owns no audit table and cannot bypass row-level security", async () => {
    const [r] = await app.$queryRaw<Array<{ su: boolean; bypass: boolean; owns: number }>>`
      SELECT r.rolsuper AS su, r.rolbypassrls AS bypass,
             (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns
      FROM pg_roles r WHERE r.rolname = current_user`
    expect(r).toEqual({ su: false, bypass: false, owns: 0 })
    expect(await auditSetupWarnings(app)).toEqual([])
    expect(await auditSetupWarnings(owner)).toEqual(expect.arrayContaining(["audit_runtime_role_owns_tables", "audit_runtime_role_can_write_evidence"]))
  })

  it("inserts and reads AuditLog, and cannot update, delete or truncate it", async () => {
    await write(1)
    const [row] = await app.auditLog.findMany({ where: { tenantId } })
    expect(row.entityId).toBe("e1")
    await denied(`UPDATE "AuditLog" SET "action" = 'EDITED' WHERE id = '${row.id}'`)
    await denied(`DELETE FROM "AuditLog" WHERE id = '${row.id}'`)
    await denied(`TRUNCATE "AuditLog"`)
  })

  it("cannot switch a trigger off, skip triggers, or take ownership of anything", async () => {
    await denied(`ALTER TABLE "AuditLog" DISABLE TRIGGER ALL`)
    await denied(`ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_a_append_only"`)
    await denied(`DROP TRIGGER "AuditLog_a_append_only" ON "AuditLog"`)
    await denied(`ALTER TABLE "AuditChainLink" DISABLE TRIGGER ALL`)
    await denied(`SET session_replication_role = replica`)
    await denied(`ALTER TABLE "AuditLog" OWNER TO CURRENT_USER`)
    await denied(`ALTER FUNCTION audit_chain_append(text, jsonb) OWNER TO CURRENT_USER`)
    await denied(`CREATE OR REPLACE FUNCTION audit_chain_append(p_key text, p_links jsonb) RETURNS int LANGUAGE sql AS 'SELECT 0'`)
    await denied(`ALTER TABLE "AuditLog" DISABLE ROW LEVEL SECURITY`)
  })

  it("has no privilege at all on the links, checkpoints, redactions and outbox", async () => {
    for (const table of ["AuditChainLink", "AuditChainCheckpoint", "AuditRedaction", "AuditSiemOutbox"]) {
      await denied(`SELECT 1 FROM "${table}"`)
      await denied(`INSERT INTO "${table}" DEFAULT VALUES`)
      await denied(`UPDATE "${table}" SET "tenantId" = "tenantId"`)
      await denied(`DELETE FROM "${table}"`)
      await denied(`TRUNCATE "${table}"`)
    }
  })

  it("cannot redact", async () => {
    const [row] = await app.auditLog.findMany({ where: { tenantId } })
    await denied(`SELECT audit_log_redact('${row.id}', ARRAY['ipAddress']::text[], 'erasure request 12345', 'app')`)
  })

  it("chains, verifies and checkpoints through the functions, and delivers the SIEM queue", async () => {
    await app.auditPolicy.create({ data: { tenantId, siemEnabled: true, siemTransport: "HTTPS_JSON", siemUrl: "https://siem.example.invalid/ingest" } })
    for (let i = 2; i <= 5; i++) await write(i)
    expect(await runChainer({ db: app, deep: true, only: [tenantId] })).toMatchObject({ chains: 1, linked: 5 })
    expect(await verifyAuditChains(app, { chainKey: tenantId, mode: "full" })).toMatchObject({ ok: true, rowsChecked: 5 })
    expect(await writeCheckpoints(app, [tenantId])).toBe(1)
    expect(await verifyAuditChains(app, { chainKey: tenantId, mode: "incremental" })).toMatchObject({ ok: true })

    const sent: number[] = []
    const send: SiemSender = async (_target, events) => {
      sent.push(...events.flatMap((e) => (e.chain.seq === null ? [] : [e.chain.seq])))
      return { ok: true, error: null }
    }
    const result = await deliverSiemOutbox({ db: app, send, now: new Date(Date.now() + 60_000) })
    expect(result.failedTenants).toBe(0)
    expect(sent).toEqual([1, 2, 3, 4, 5, 5])
  })

  it("cannot forge a link, a checkpoint or a queued event through the functions", async () => {
    const [head] = await app.$queryRaw<Array<{ seq: number; rowHash: string }>>`SELECT * FROM audit_chain_head(${tenantId})`
    const [last] = await app.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 1 })
    const link = (over: Record<string, unknown>) => JSON.stringify([{ seq: head.seq + 1, auditLogId: last.id, prevHash: head.rowHash, rowHash: "a".repeat(64), ...over }])
    const append = (links: string, key = tenantId) => app.$queryRaw`SELECT audit_chain_append(${key}, ${links}::jsonb)`
    await write(6)
    const [fresh] = await app.auditLog.findMany({ where: { tenantId }, orderBy: { createdAt: "desc" }, take: 1 })

    await expect(append(link({ auditLogId: fresh.id, prevHash: "b".repeat(64) }))).rejects.toThrow(/does not continue the chain/)
    await expect(append(link({ auditLogId: fresh.id, seq: head.seq + 2 }))).rejects.toThrow(/does not continue the chain/)
    await expect(append(link({ auditLogId: "no-such-row" }))).rejects.toThrow(/names no audit row/)
    await expect(append(link({ auditLogId: fresh.id }), other)).rejects.toThrow(/does not continue|names no audit row/)
    await expect(append(link({ auditLogId: fresh.id, rowHash: "short" }))).rejects.toThrow(/malformed rowHash/)
    await expect(app.$queryRaw`SELECT audit_checkpoint_write(${tenantId}, ${head.seq + 5}::int, ${"c".repeat(64)}, ${"d".repeat(64)})`).rejects.toThrow(/no such link/)
    await expect(app.$queryRaw`SELECT audit_checkpoint_write(${tenantId}, ${head.seq}::int, ${"c".repeat(64)}, ${"d".repeat(64)})`).rejects.toThrow(/no such link/)
    await expect(app.$queryRaw`SELECT audit_outbox_mark(ARRAY[1]::int[], 'unknown', NULL, now()::timestamp)`).rejects.toThrow(/unknown state/)

    // Nothing the refused calls tried is in the chain.
    expect(await runChainer({ db: app, deep: true, only: [tenantId] })).toMatchObject({ linked: 1 })
    expect(await verifyAuditChains(app, { chainKey: tenantId, mode: "full" })).toMatchObject({ ok: true, rowsChecked: 6 })
  })

  it("leaves the function's row-level-security bypass behind when it returns", async () => {
    await app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT * FROM audit_chain_head(${tenantId})`
      const [r] = await tx.$queryRaw<Array<{ v: string | null }>>`SELECT current_setting('app.rls_bypass', true) AS v`
      expect(r.v ?? "").not.toBe("on")
    })
  })
})
