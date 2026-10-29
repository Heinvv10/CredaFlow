/**
 * Test-only access to AuditLog rows the application can never change.
 *
 * AuditLog is append-only (migration 20261029100000), so an integration suite
 * cannot `deleteMany` its own rows on teardown. These helpers do what only a
 * database superuser can: they switch the session to `replica`, which skips
 * every trigger (the append-only guard, the hash chain) and the foreign-key
 * checks, for one transaction. The suites run as the superuser of a disposable
 * database; the application never does this and has no import path to here.
 *
 * A purge also removes what hangs off the rows it removes: their AuditChainLink,
 * AuditRedaction and AuditSiemOutbox rows, and every AuditChainCheckpoint of the
 * chains they were in. A partial purge leaves a chain with a gap, which the
 * verifier reports; that is for a tenant a suite made and is dropping anyway. A
 * suite that creates a tenant, audits for it and then deletes the tenant (or one
 * of its users) must call purgeAuditRowsForTest for the tenant first: the foreign
 * keys on AuditLog are RESTRICT.
 */
import type { Prisma } from "@prisma/client"

interface AuditTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  auditLog: {
    findMany(args: { where?: Prisma.AuditLogWhereInput; select: { id: true; tenantId: true } }): Promise<Array<{ id: string; tenantId: string | null }>>
    deleteMany(args: { where?: Prisma.AuditLogWhereInput }): Promise<{ count: number }>
    updateMany(args: { where?: Prisma.AuditLogWhereInput; data: Prisma.AuditLogUncheckedUpdateManyInput }): Promise<{ count: number }>
  }
}

export interface AuditTestDb {
  $transaction<T>(fn: (tx: AuditTx) => Promise<T>): Promise<T>
}

const REPLICA = `SET LOCAL session_replication_role = replica`

const CHUNK = 5000

export function purgeAuditRowsForTest(db: AuditTestDb, where: Prisma.AuditLogWhereInput): Promise<{ count: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(REPLICA)
    const rows = await tx.auditLog.findMany({ where, select: { id: true, tenantId: true } })
    const chains = [...new Set(rows.map((r) => r.tenantId ?? ""))]
    for (let i = 0; i < rows.length; i += CHUNK) {
      const ids = rows.slice(i, i + CHUNK).map((r) => `'${r.id.replaceAll("'", "''")}'`).join(",")
      for (const table of ["AuditChainLink", "AuditRedaction", "AuditSiemOutbox"]) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "auditLogId" IN (${ids})`)
      }
    }
    for (const chain of chains) await tx.$executeRawUnsafe(`DELETE FROM "AuditChainCheckpoint" WHERE "chainKey" = '${chain.replaceAll("'", "''")}'`)
    return tx.auditLog.deleteMany({ where })
  })
}

export function updateAuditRowsForTest(
  db: AuditTestDb,
  where: Prisma.AuditLogWhereInput,
  data: Prisma.AuditLogUncheckedUpdateManyInput,
): Promise<{ count: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(REPLICA)
    return tx.auditLog.updateMany({ where, data })
  })
}

/** Runs one statement against AuditLog with the triggers off (to corrupt a row on purpose). */
export function tamperAuditRowsForTest(db: AuditTestDb, sql: string): Promise<number> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(REPLICA)
    return tx.$executeRawUnsafe(sql)
  })
}
