/**
 * Shared setup for the audit integration suites (real Postgres, RUN_DB_IT=1): a plain client on the
 * owner/superuser connection, a unique token, lenders created and torn down (AuditLog is
 * append-only, so teardown goes through audit-rows.test-helpers), and the helpers every suite uses.
 */
import { randomUUID } from "node:crypto"
import { describe } from "vitest"
import { PrismaClient } from "@prisma/client"
import { logAuditStrict } from "@/lib/audit"
import { columnDigest, type HashedColumn } from "./chain-hash"
import { verifyAuditChains } from "./chain-verify"
import { runChainer } from "./chainer"
import { purgeAuditPolicyForTest, purgeAuditRowsForTest, tamperAuditRowsForTest } from "./audit-rows.test-helpers"

export const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip

// logAuditStrict types its client as the tenant-scoped extension; a plain client does the same write.
export type Writer = Parameters<typeof logAuditStrict>[1]

export function auditFixture(labels: readonly string[]) {
  process.env.AUDIT_CHAIN_KEY ??= "it-audit-chain-key-0123456789abcdef0123456789"
  const db = new PrismaClient()
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const ids = Object.fromEntries(labels.map((k) => [k, `aud-${k}-${token}`])) as Record<string, string>
  const tenantIds = Object.values(ids)
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
  /** What scripts/audit-redact.ts does: keyed digests of the values being removed, then audit_log_redact. */
  const redact = async (id: string, cols: HashedColumn[], reason = "POPIA erasure request ref 42", op = "it-operator") => {
    const [row] = await db.$queryRaw<Array<Record<HashedColumn, string | null>>>`
      SELECT "userEmail", "ipAddress", "oldValue"::text AS "oldValue", "newValue"::text AS "newValue" FROM "AuditLog" WHERE "id" = ${id}`
    const digests = Object.fromEntries(cols.map((c) => [c, columnDigest(c, row ? row[c] : "")]))
    return db.$executeRaw`SELECT public.audit_log_redact(${id}, ${cols}::text[], ${reason}, ${op}, ${JSON.stringify(digests)}::jsonb)`
  }
  const setup = async () => { await db.tenant.createMany({ data: tenantIds.map((id) => ({ id, slug: id, name: id })) }) }
  const teardown = async () => {
    await purgeAuditPolicyForTest(db, tenantIds)
    await purgeAuditRowsForTest(db, { tenantId: { in: tenantIds } })
    await db.branch.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await db.user.deleteMany({ where: { tenantId: { in: tenantIds } } })
    await tamper(`DELETE FROM "AuditChainLink" WHERE "chainKey" = ANY('{${tenantIds.join(",")}}')`)
    await db.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await db.$disconnect()
  }
  return { db, token, ids, tenantIds, write, rows, links, chain, verify, tamper, tenant, redact, setup, teardown }
}
