/**
 * How many of a lender's decision records a retention period would
 * pseudonymise if the nightly job ran now: read-only, from the same database
 * clock the job uses (agedCreditDecisionRecordIds), so the settings screen can
 * tell a SUPER_ADMIN what saving a period will irreversibly do.
 */
import { prisma } from "@/lib/prisma"

export type PreviewDb = Pick<typeof prisma, "$transaction">

export async function countDecisionRecordsAgedBy(tenantId: string, months: number, db: PreviewDb = prisma): Promise<number> {
  return db.$transaction(async (tx) => {
    // As the job: name the tenant to the transaction, so RLS binds the read even with TENANT_RLS off.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    const [row] = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::integer AS "count"
      FROM public."agedCreditDecisionRecordIds"(${tenantId}, ${months}::integer, now() AT TIME ZONE 'UTC')`
    return row?.count ?? 0
  })
}
