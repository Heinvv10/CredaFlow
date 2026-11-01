import { OPEN_APPLICATION_STATUSES } from "@/lib/applications/open-application"
import type { Tx } from "@/lib/maker-checker/types"
import type { prisma } from "@/lib/prisma"

/** The ID numbers of a group's members: at least two different ones, or null. */
export function memberIdNumbers(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.trim().length === 0)) return null
  const ids = [...new Set(raw.map((v: string) => v.trim()))]
  return ids.length >= 2 && ids.length <= 100 ? ids : null
}

/** The lender's clients with these ID numbers, or the ID numbers it has no client for. */
export async function resolveMembers(db: Pick<typeof prisma, "client">, tenantId: string, idNumbers: string[]): Promise<{ clientIds: string[] } | { missing: string[] }> {
  const rows = await db.client.findMany({ where: { tenantId, idNumber: { in: idNumbers } }, select: { id: true, idNumber: true } })
  const found = new Set(rows.map((r) => r.idNumber))
  const missing = idNumbers.filter((id) => !found.has(id))
  return missing.length > 0 ? { missing } : { clientIds: rows.map((r) => r.id) }
}

/**
 * A change of members moves a group loan's gate (lib/product-types/rules.ts), so whoever makes it is input staff of every open application
 * on the group, in the change's transaction: approval, the matrix and disbursement then keep them out. The rows are locked in id order,
 * as a decision locks one, so an approval cannot read the old membership after this commits.
 */
export async function recordGroupEditor(tx: Tx, tenantId: string, groupId: string, userId: string): Promise<number> {
  const rows = await tx.applicationProductFacts.findMany({ where: { tenantId, borrowerGroupId: groupId, application: { status: { in: [...OPEN_APPLICATION_STATUSES] } } }, select: { applicationId: true } })
  const ids = rows.map((r) => r.applicationId).sort()
  if (ids.length === 0) return 0
  await tx.$queryRaw`SELECT "id" FROM "LoanApplication" WHERE "tenantId" = ${tenantId} AND "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`
  await tx.loanApplication.updateMany({ where: { tenantId, id: { in: ids }, NOT: { inputStaffIds: { has: userId } } }, data: { inputStaffIds: { push: userId } } })
  return ids.length
}
