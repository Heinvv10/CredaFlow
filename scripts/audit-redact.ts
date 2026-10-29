/**
 * Removes personal data from one AuditLog row through audit_log_redact()
 * (migration 20261029100000): a documented POPIA erasure that keeps the hash chain
 * verifiable and writes its own AUDIT_ROW_REDACTED row. Run by a person with the
 * operator database role the function was granted to, never by the application.
 *
 * The keyed digest of each removed value (HMAC under AUDIT_CHAIN_KEY, which this tool holds and
 * the database does not) is computed here and handed to the function, so the database never
 * keeps an unkeyed digest of an email, an address or a value.
 *
 *   AUDIT_CHAIN_KEY=<key> DATABASE_URL=<operator role> npm run audit:redact -- <auditLogId> <col[,col]> "<reason>" <operator name>
 *   columns: userEmail, ipAddress, oldValue, newValue
 */
import { PrismaClient } from "@prisma/client"
import { columnDigest, HASHED_COLUMNS, type HashedColumn } from "@/lib/audit/chain-hash"

type Inputs = { userEmail: string | null; ipAddress: string | null; oldValue: string | null; newValue: string | null }

async function main(): Promise<number> {
  const [auditLogId, columns, reason, operator] = process.argv.slice(2)
  if (!auditLogId || !columns || !reason || !operator) {
    process.stderr.write('usage: audit-redact <auditLogId> <col[,col]> "<reason>" <operator>\n')
    return 2
  }
  const cols = columns.split(",") as HashedColumn[]
  const unknown = cols.filter((c) => !HASHED_COLUMNS.includes(c))
  if (unknown.length > 0) {
    process.stderr.write(`unknown column(s): ${unknown.join(", ")}\n`)
    return 2
  }
  const db = new PrismaClient()
  try {
    const [row] = await db.$queryRaw<Inputs[]>`
      SELECT "userEmail", "ipAddress", "oldValue"::text AS "oldValue", "newValue"::text AS "newValue" FROM "AuditLog" WHERE "id" = ${auditLogId}`
    if (!row) {
      process.stderr.write("no such audit row\n")
      return 2
    }
    const digests = Object.fromEntries(cols.map((c) => [c, columnDigest(c, row[c])]))
    await db.$executeRaw`SELECT public.audit_log_redact(${auditLogId}, ${cols}::text[], ${reason}, ${operator}, ${JSON.stringify(digests)}::jsonb)`
    process.stdout.write(`redacted ${columns} on ${auditLogId}\n`)
    return 0
  } finally {
    await db.$disconnect()
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`audit-redact failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  },
)
