/**
 * Creates an asset-finance deal (goal §4.7): the entity's LoanApplication
 * (DRAFT) and its AssetFinanceDeal, in the caller's transaction.
 *
 *   - Asset: the row is locked FOR UPDATE, so two deals cannot claim it at
 *     once; it must be unreleased and on no other open deal (OPEN = any status
 *     but REFUSED_NCA, DECLINED, CANCELLED; a BOOKED deal still holds it).
 *   - Supplier: active. Product: the tenant's, active; the financed amount and
 *     term must sit within its bounds.
 *   - Rate and structure: resolved and solved as in ./deal-structure.ts; any
 *     refusal is a 422 with the solver's reason.
 *   - The application: appliedAmount = the financed amount, appliedTermDays =
 *     days from the indicative start to the last due date, status DRAFT, NCA
 *     regime unclassified (submit classifies it).
 *
 * SURETIES are not stored on the deal: a deal's sureties are its entity's
 * ACTIVE EntityRelationship rows with role SURETY at the time they are read
 * (deal detail, and the signers at contracting).
 */
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { generateReference } from "@/lib/utils"
import type { RegimeTx } from "./classification"
import type { DealCreateInput } from "./deal-input"
import { solveWithRate } from "./deal-structure"
import { dbDate } from "./dates"

export const CLOSED_DEAL_STATUSES = ["REFUSED_NCA", "DECLINED", "CANCELLED"] as const

export type CreateDealResult =
  | { kind: "created"; dealId: string }
  | { kind: "refused"; status: 404 | 409 | 422; error: string }

const refused = (status: 404 | 409 | 422, error: string): CreateDealResult => ({ kind: "refused", status, error })

export async function createDeal(
  tx: RegimeTx,
  params: { tenantId: string; userId: string; userEmail?: string; input: DealCreateInput },
): Promise<CreateDealResult> {
  const { tenantId, input } = params

  const entity = await tx.businessEntity.findFirst({ where: { id: input.entityId, tenantId }, select: { id: true, legalName: true } })
  if (!entity) return refused(422, "The entity is not on this lender's book")
  const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, tenantId }, select: { active: true } })
  if (!supplier) return refused(422, "The supplier is not on this lender's book")
  if (!supplier.active) return refused(422, "The supplier is inactive")
  const product = await tx.loanProduct.findFirst({
    where: { id: input.productId, tenantId, active: true },
    select: { id: true, minAmount: true, maxAmount: true, minTermDays: true, maxTermDays: true },
  })
  if (!product) return refused(422, "The product is not an active product of this lender")

  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "FinancedAsset" WHERE "id" = ${input.assetId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  if (locked.length === 0) return refused(422, "The asset is not on this lender's register")
  const asset = await tx.financedAsset.findFirst({
    where: { id: input.assetId, tenantId },
    select: { cashPriceExclVatCents: true, vatCents: true, releasedAt: true, make: true, model: true, serialNumber: true },
  })
  if (!asset) return refused(422, "The asset is not on this lender's register")
  if (asset.releasedAt) return refused(409, "The asset has been released and cannot be financed again")
  const other = await tx.assetFinanceDeal.findFirst({
    where: { tenantId, assetId: input.assetId, status: { notIn: [...CLOSED_DEAL_STATUSES] } },
    select: { id: true, status: true },
  })
  if (other) return refused(409, `The asset is already on an open deal (${other.status})`)

  const solved = await solveWithRate(tx, tenantId, asset, input.terms)
  if (!solved.ok) return refused(422, solved.error)
  const amount = solved.result.financedAmountCents
  if (amount < product.minAmount || amount > product.maxAmount) {
    return refused(422, `The financed amount ${amount} cents is outside the product's ${product.minAmount}–${product.maxAmount}`)
  }
  if (solved.termDays < product.minTermDays || solved.termDays > product.maxTermDays) {
    return refused(422, `The term of ${solved.termDays} days is outside the product's ${product.minTermDays}–${product.maxTermDays}`)
  }

  const { terms } = input
  const application = await tx.loanApplication.create({
    data: {
      tenantId,
      reference: generateReference("AF"),
      entityId: entity.id,
      productId: product.id,
      appliedAmount: amount,
      appliedTermDays: solved.termDays,
      purpose: `Asset finance: ${asset.make} ${asset.model} (${asset.serialNumber})`,
      status: "DRAFT",
    },
    select: { id: true, reference: true },
  })
  const deal = await tx.assetFinanceDeal.create({
    data: {
      tenantId,
      applicationId: application.id,
      entityId: entity.id,
      assetId: input.assetId,
      supplierId: input.supplierId,
      contractType: "INSTALMENT_SALE",
      status: "DRAFT",
      depositCents: terms.depositCents,
      tradeInCents: terms.tradeInCents,
      financedFeesCents: terms.financedFeesCents,
      balloonCents: terms.balloonCents,
      weights: terms.weights,
      structurePreset: terms.preset,
      firstDueDate: dbDate(terms.firstDueDate),
      vatDeferralPeriodIndex: terms.vatDeferralPeriodIndex,
      rateBasis: terms.rate.basis,
      rateMargin: terms.rate.margin,
      fixedRate: terms.rate.fixedRate,
      baseInstalmentCents: solved.result.baseInstalmentCents,
      createdById: params.userId,
    },
    select: { id: true },
  })
  await logAuditStrict(
    {
      tenantId,
      userId: params.userId,
      userEmail: params.userEmail,
      action: AuditAction.ASSET_DEAL_CREATED,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      newValue: {
        applicationId: application.id,
        applicationReference: application.reference,
        entityId: entity.id,
        assetId: input.assetId,
        supplierId: input.supplierId,
        productId: product.id,
        financedAmountCents: amount,
        termDays: solved.termDays,
        baseInstalmentCents: solved.result.baseInstalmentCents,
        preset: terms.preset,
        weights: terms.weights,
        firstDueDate: terms.firstDueDate,
        rateBasis: terms.rate.basis,
        rateMargin: terms.rate.margin,
        fixedRate: terms.rate.fixedRate,
        annualRate: solved.rate.annualRate,
        reference: solved.rate.reference,
      },
    },
    tx,
  )
  return { kind: "created", dealId: deal.id }
}
