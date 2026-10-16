import type { Prisma } from "@prisma/client"
import { lenderHoldsFsp } from "@/lib/insurance/require-fsp"

export type CreditLifeBundleReader = {
  insuranceProduct: {
    findFirst: (args: { where: Prisma.InsuranceProductWhereInput; select: { id: true; insurerId: true; commissionRate: true } }) =>
      Promise<{ id: string; insurerId: string | null; commissionRate: Prisma.Decimal } | null>
  }
  tenantConfig: { findUnique: (args: { where: { tenantId: string }; select: { fscaNumber: true } }) => Promise<{ fscaNumber: string | null } | null> }
}
export type CreditLifeBundle = { clientId: string; productId: string; insurerId: string | null; commissionRate: Prisma.Decimal; premiumAmount: number }

/**
 * The credit-life policy an NCA booking binds, when the signed election
 * accepted cover: the elected product must still be active, and the lender
 * must hold an FSP number (a lender without one issues no insurance; Fair
 * Score audit goal §2a.2).
 */
export async function creditLifeBundleFor(
  tx: CreditLifeBundleReader,
  tenantId: string,
  accepted: boolean,
  application: { creditLifeProductId: string | null; creditLifeMonthlyPremiumCents: number | null },
  client: { id: string } | null,
): Promise<{ bundle: CreditLifeBundle | null } | { reason: string; error: string }> {
  if (!accepted) return { bundle: null }
  if (!application.creditLifeProductId || !application.creditLifeMonthlyPremiumCents || !client) {
    return { reason: "credit_life_evidence", error: "Accepted credit life is missing its product or premium evidence" }
  }
  const product = await tx.insuranceProduct.findFirst({ where: {
    id: application.creditLifeProductId, tenantId, type: "CREDIT_LIFE", active: true,
  }, select: { id: true, insurerId: true, commissionRate: true } })
  if (!product) return { reason: "credit_life_product", error: "The elected credit-life product is no longer active" }
  if (!(await lenderHoldsFsp(tx, tenantId))) {
    return { reason: "credit_life_no_fsp", error: "Credit life was accepted, but the lender holds no FSP licence number, so no policy can be bound. Return the deal for a current election." }
  }
  return { bundle: {
    clientId: client.id, productId: product.id, insurerId: product.insurerId,
    commissionRate: product.commissionRate, premiumAmount: application.creditLifeMonthlyPremiumCents / 100,
  } }
}
