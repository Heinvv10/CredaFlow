/**
 * Booking's first step (./booking.ts): lock the deal, its application and its
 * asset FOR UPDATE, in that order, and load what booking writes from. Refuses
 * a deal that is not ready: not CONTRACTED, application not APPROVED and
 * NON_NCA, payout not APPROVED or its account no longer APPROVED, or a
 * contract type asset finance does not book. A lease (operating or
 * full-maintenance) is NON_NCA for an entity or a sole proprietor alike.
 */
import { Prisma } from "@prisma/client"
import type { SigningTx } from "./signing-prepare"
import { DEAL_STRUCTURE_SELECT } from "./deal-terms"
import { isLeaseContract } from "./lease-input"

export interface BookingRefusal {
  kind: "refused"
  reason: string
  error: string
}

const refuse = (reason: string, error: string): BookingRefusal => ({ kind: "refused", reason, error })

const BOOKING_SELECT = {
  ...DEAL_STRUCTURE_SELECT,
  id: true,
  status: true,
  contractType: true,
  cpaApplies: true,
  cpaRule: true,
  plannedStartDate: true,
  signedBaseInstalmentCents: true,
  signedResultingRate: true,
  signedTotalInterestCents: true,
  signedArrearsMarginRate: true,
  signedCollectionFeeCents: true,
  checklist: {
    where: { item: "SUPPLIER_INVOICE_MATCHES_ASSET", confirmedAt: { not: null } },
    select: { attestedIdentifier: true },
  },
  application: {
    select: {
      id: true, status: true, ncaRegime: true, productId: true, appliedAmount: true, approvedAmount: true,
      pasqEvidence: true, agreementDocumentId: true, agreementCountersignedAt: true,
      creditLifeElection: true, creditLifeProductId: true, creditLifeMonthlyPremiumCents: true,
    },
  },
  asset: { select: { id: true, make: true, model: true, year: true, serialNumber: true, vin: true, cashPriceExclVatCents: true, vatCents: true, hours: true, odometerKm: true } },
  entity: {
    select: { id: true, legalName: true, vatNumber: true, addressLine1: true, addressLine2: true, city: true, province: true, postalCode: true },
  },
  client: {
    select: { id: true, firstName: true, lastName: true, addressLine1: true, city: true, province: true, postalCode: true },
  },
  payout: { select: { id: true, status: true, amountCents: true, supplierBankAccount: { select: { status: true } } } },
} as const satisfies Prisma.AssetFinanceDealSelect

type Loaded = Prisma.AssetFinanceDealGetPayload<{ select: typeof BOOKING_SELECT }>
export type BookingDeal = Omit<Loaded, "payout"> & {
  payout: NonNullable<Loaded["payout"]>
}

export type LoadResult = { kind: "not_found" } | BookingRefusal | { kind: "loaded"; deal: BookingDeal }

type EntityAddress = Pick<NonNullable<Loaded["entity"]>, "addressLine1" | "city" | "province" | "postalCode"> & { addressLine2?: string | null }

/** The entity's address as invoice lines, or null without a first line and a city. */
export function recipientAddress(entity: EntityAddress): string | null {
  const line1 = entity.addressLine1?.trim()
  const city = entity.city?.trim()
  if (!line1 || !city) return null
  return [line1, entity.addressLine2, city, entity.province, entity.postalCode]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part)
    .join("\n")
}

export async function loadBookingDeal(tx: SigningTx, tenantId: string, dealId: string): Promise<LoadResult> {
  const lockedDeal = await tx.$queryRaw<Array<{ status: string; applicationId: string; assetId: string }>>(Prisma.sql`
    SELECT "status"::TEXT AS "status", "applicationId", "assetId" FROM "AssetFinanceDeal"
    WHERE "id" = ${dealId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)
  const head = lockedDeal[0]
  if (!head) return { kind: "not_found" }
  if (head.status === "BOOKED") return refuse("already_booked", "The deal is already booked")
  if (head.status !== "CONTRACTED") return refuse("not_contracted", `Only a CONTRACTED deal is booked; this one is ${head.status}`)
  await tx.$queryRaw(Prisma.sql`
    SELECT 1 FROM "LoanApplication" WHERE "id" = ${head.applicationId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)
  await tx.$queryRaw(Prisma.sql`
    SELECT 1 FROM "FinancedAsset" WHERE "id" = ${head.assetId} AND "tenantId" = ${tenantId} FOR UPDATE
  `)

  const deal = await tx.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: BOOKING_SELECT })
  if (!deal) return { kind: "not_found" }
  const lease = isLeaseContract(deal.contractType)
  if (deal.contractType !== "INSTALMENT_SALE" && deal.contractType !== "FINANCE_LEASE" && !lease) return refuse("contract_type", `Asset finance cannot book ${deal.contractType}`)
  if (deal.application.status !== "APPROVED" || !deal.application.ncaRegime) {
    return refuse("application_not_ready", `The application must be APPROVED and classified (it is ${deal.application.status}, ${deal.application.ncaRegime ?? "unclassified"})`)
  }
  if (deal.application.ncaRegime === "NON_NCA" && !deal.entity && !lease) {
    return refuse("borrower_mismatch", "A NON_NCA asset deal must have an entity borrower")
  }
  if (deal.application.ncaRegime === "NCA" && (!deal.application.agreementDocumentId || !deal.application.agreementCountersignedAt)) {
    return refuse("agreement_not_ready", "The NCA agreement must be signed and countersigned before booking")
  }
  const { payout } = deal
  if (!payout) return refuse("no_payout", "Create the supplier payout first")
  if (payout.status !== "APPROVED") return refuse("payout_not_approved", `The payout must be APPROVED (it is ${payout.status})`)
  if (payout.supplierBankAccount.status !== "APPROVED") {
    return refuse("account_not_approved", "The payout's bank account is no longer the supplier's APPROVED account")
  }
  return { kind: "loaded", deal: { ...deal, payout } }
}
