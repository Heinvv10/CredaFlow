import { prisma } from "@/lib/prisma"

/**
 * Whether the lender pays for Statement AI (TenantConfig.featureStatementAi).
 * Read live, uncached: the routes 404 and the worker generates nothing while
 * it is off. A tenant with no config row is off.
 */
export async function statementAiEnabled(tenantId: string, db: Pick<typeof prisma, "tenantConfig"> = prisma): Promise<boolean> {
  const row = await db.tenantConfig.findUnique({ where: { tenantId }, select: { featureStatementAi: true } })
  return row?.featureStatementAi === true
}
