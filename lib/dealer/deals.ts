/**
 * A dealer's deals: creation through the unchanged createDeal with its
 * `dealer` parameter (lib/asset-finance/deal-create.ts), and the lookup every
 * dealer action on a deal starts with — the deal of this lender AND this
 * dealer, or "not found" (another dealer's or lender's deal included).
 *
 * Provenance: the borrower and the asset must be ones this dealer captured
 * (createdByDealerId). The database refuses anything else
 * (guardAssetDealDealer); this checks first so the dealer gets a 404, not a
 * refused write. Supplier: an active supplier of the lender (the dealer's own
 * linked supplier when the body names none). Product: the lender's active
 * asset-finance products, as createDeal checks.
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import { createDeal } from "@/lib/asset-finance/deal-create"
import { parseDealCreate } from "@/lib/asset-finance/deal-input"
import { ASSET_FINANCE_PRODUCT_WHERE } from "@/lib/asset-finance/deal-products"
import type { DealerActor } from "./actor"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

/** The where-clause of the dealer's own deal: any other deal is "not found". */
export function dealerDealWhere(actor: Pick<DealerActor, "tenantId" | "dealerId">, dealId: string) {
  return { id: dealId, tenantId: actor.tenantId, dealerId: actor.dealerId }
}

/** The lender's active suppliers (id and name only) and the dealer's own as the default. */
export async function dealerSupplierChoices(actor: DealerActor): Promise<{ suppliers: { id: string; name: string }[]; defaultSupplierId: string | null }> {
  const [suppliers, dealer] = await Promise.all([
    prisma.supplier.findMany({ where: { tenantId: actor.tenantId, active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.dealer.findFirst({ where: { id: actor.dealerId, tenantId: actor.tenantId }, select: { supplierId: true } }),
  ])
  const defaultSupplierId = suppliers.some((s) => s.id === dealer?.supplierId) ? dealer?.supplierId ?? null : null
  return { suppliers, defaultSupplierId }
}

/** The lender's active asset-finance products, as a dealer may choose them. */
export function dealerProductChoices(actor: DealerActor) {
  return prisma.loanProduct.findMany({
    where: { tenantId: actor.tenantId, ...ASSET_FINANCE_PRODUCT_WHERE },
    select: { id: true, name: true, minAmount: true, maxAmount: true, minTermDays: true, maxTermDays: true },
    orderBy: { name: "asc" },
  })
}

export type CreateDealerDealResult = { kind: "created"; dealId: string } | { kind: "invalid"; fields: Record<string, string> } | DealerRefusal

export async function createDealerDeal(actor: DealerActor, body: unknown): Promise<CreateDealerDealResult> {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  let supplierId = record.supplierId
  if (supplierId === undefined || supplierId === null || supplierId === "") {
    supplierId = (await dealerSupplierChoices(actor)).defaultSupplierId ?? undefined
  }
  const parsed = parseDealCreate({ ...record, supplierId }, sastCalendarDate(new Date()))
  if ("errors" in parsed) return { kind: "invalid", fields: parsed.errors }
  const input = parsed.data
  const mine = { tenantId: actor.tenantId, createdByDealerId: actor.dealerId }
  const [entity, client, asset] = await Promise.all([
    // An erased (purged) person or business is gone for the dealer (guardDealerPurgedPartyUse).
    input.entityId === null ? null : prisma.businessEntity.findFirst({ where: { id: input.entityId, ...mine, dealerPurgedAt: null }, select: { id: true } }),
    input.clientId === null ? null : prisma.client.findFirst({ where: { id: input.clientId, ...mine, dealerPurgedAt: null }, select: { id: true } }),
    prisma.financedAsset.findFirst({ where: { id: input.assetId, ...mine }, select: { id: true } }),
  ])
  if ((input.entityId !== null && !entity) || (input.clientId !== null && !client)) return dealerMiss("Borrower")
  if (!asset) return dealerMiss("Asset")

  let result: Awaited<ReturnType<typeof createDeal>>
  try {
    result = await prisma.$transaction((tx) => createDeal(tx, {
      tenantId: actor.tenantId, userId: actor.dealerUserId, userEmail: actor.email, input,
      dealer: { dealerId: actor.dealerId, dealerUserId: actor.dealerUserId, email: actor.email },
    }))
  } catch (error) {
    if (isCheckViolation(error)) return dealerRefused(409, "The lender's system refused the deal; check the details and try again")
    throw error
  }
  return result.kind === "refused" ? dealerRefused(result.status, result.error) : result
}
