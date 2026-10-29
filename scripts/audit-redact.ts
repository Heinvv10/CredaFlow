/**
 * Removes personal data from one AuditLog row through audit_log_redact()
 * (migration 20261029100000): a documented POPIA erasure that keeps the hash chain
 * verifiable and writes its own AUDIT_ROW_REDACTED row. Run by a person with the
 * operator database role the function was granted to, never by the application.
 *
 *   DATABASE_URL=<operator role> npm run audit:redact -- <auditLogId> <col[,col]> "<reason>" <operator name>
 *   columns: userEmail, ipAddress, oldValue, newValue
 */
import { PrismaClient } from "@prisma/client"

async function main(): Promise<number> {
  const [auditLogId, columns, reason, operator] = process.argv.slice(2)
  if (!auditLogId || !columns || !reason || !operator) {
    process.stderr.write('usage: audit-redact <auditLogId> <col[,col]> "<reason>" <operator>\n')
    return 2
  }
  const db = new PrismaClient()
  try {
    await db.$executeRaw`SELECT public.audit_log_redact(${auditLogId}, ${columns.split(",")}::text[], ${reason}, ${operator})`
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
