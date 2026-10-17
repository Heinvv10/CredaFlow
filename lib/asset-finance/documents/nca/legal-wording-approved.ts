import type { prisma } from "@/lib/prisma"

/** TenantConfig.assetFinanceLegalWordingApproved; a missing row or column reads as not approved (DRAFT). */
export async function legalWordingApproved(db: Pick<typeof prisma, "tenantConfig">, tenantId: string): Promise<boolean> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { assetFinanceLegalWordingApproved: true } })
  return config?.assetFinanceLegalWordingApproved === true
}
