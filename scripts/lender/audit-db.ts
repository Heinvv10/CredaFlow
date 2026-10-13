import type { Prisma } from "@prisma/client"
import type { logAuditStrict } from "@/lib/audit"

/**
 * lib/audit.ts types its `db` as the app's tenant-scope-extended client. These
 * scripts use a plain PrismaClient transaction, which writes the same
 * AuditLog row (AuditLog is not a tenant-scoped model), so the type is bridged here.
 */
export const auditDb = (tx: Prisma.TransactionClient) => tx as unknown as NonNullable<Parameters<typeof logAuditStrict>[1]>
