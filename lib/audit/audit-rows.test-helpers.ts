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
 * A purge leaves the chain's head ahead of the table. That is fine for a
 * tenant a suite made and drops, and is exactly what the verifier reports for
 * a tenant that matters.
 */
import type { Prisma } from "@prisma/client"

interface AuditTx {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
  auditLog: {
    deleteMany(args: { where?: Prisma.AuditLogWhereInput }): Promise<{ count: number }>
    updateMany(args: { where?: Prisma.AuditLogWhereInput; data: Prisma.AuditLogUncheckedUpdateManyInput }): Promise<{ count: number }>
  }
}

export interface AuditTestDb {
  $transaction<T>(fn: (tx: AuditTx) => Promise<T>): Promise<T>
}

const REPLICA = `SET LOCAL session_replication_role = replica`

export function purgeAuditRowsForTest(db: AuditTestDb, where: Prisma.AuditLogWhereInput): Promise<{ count: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(REPLICA)
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
