/**
 * Dealer origination through the lib functions the dealer portal routes call
 * (lib/dealer/capture.ts, deals.ts, documents.ts), for the
 * RUN_ASSET_FINANCE_DEALER_IT suites: the actors of the dealer fixture, a
 * dealer-captured company with one director, an asset, a DRAFT deal on them,
 * and a synthetic PDF upload. Every value is synthetic. Not a test file.
 */
import { randomInt } from "node:crypto"
import { runWithTenant } from "@/lib/tenant-scope"
import { sastCalendarDate } from "@/lib/date/sast"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import { syntheticSaIdNumber } from "@/lib/asset-finance/synthetic-sa-id.integration-fixture"
import type { ParsedEntityUpload } from "@/lib/asset-finance/entity-document-io"
import type { DealerActor, StaffActor } from "./actor"
import { captureDealerAsset, captureDealerEntity, captureDealerPerson, type CaptureResult } from "./capture"
import { createDealerDeal } from "./deals"
import type { DealerFixture } from "./dealer.integration-fixture"

export const actorOf = (fx: DealerFixture, dealerUserId: string, dealerId: string, role: DealerActor["dealerRole"] = "DEALER_SALES"): DealerActor => ({
  tenantId: fx.tenantId, dealerId, dealerUserId, email: `${dealerUserId}@dealer.invalid`, dealerRole: role,
})
export const staffOf = (fx: DealerFixture, userId = fx.officer): StaffActor => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@staff.invalid` })

/** Runs `fn` in the fixture lender's tenant scope, as a route's withTenantContext does. */
export const inTenant = <T>(fx: DealerFixture, fn: () => Promise<T>) => runWithTenant(fx.tenantId, fn)

export function createdId(result: CaptureResult): string {
  if (result.kind !== "created") throw new Error(`not created: ${JSON.stringify(result)}`)
  return result.id
}

export const registrationNumber = () => `20${randomInt(10, 99)}/${String(randomInt(0, 999_999)).padStart(6, "0")}/07`
/** A synthetic address: a borrower the dealer captures carries one (booking's tax invoice needs it). */
export const ADDRESS = { addressLine1: "1 Synthetic Road", city: "Testville", province: "Gauteng", postalCode: "0001" }
export const companyBody = (reg = registrationNumber()) => ({ type: "COMPANY", legalName: "TEST Dealer Plant (Pty) Ltd", registrationNumber: reg, ...ADDRESS })
export const personBody = (over: Record<string, unknown> = {}) => ({
  idNumber: syntheticSaIdNumber(), firstName: "TEST", lastName: "Director",
  email: `director-${randomInt(0, 1e9)}@client.invalid`, phone: "+27820000000", roles: ["DIRECTOR"], ...ADDRESS, ...over,
})
export const assetBody = () => ({
  assetClass: "TLB", make: "TEST", model: "TLB-1", year: 2025, serialNumber: `TESTDLR${randomInt(0, 1e9)}`,
  cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
})
export const dealBody = (fx: DealerFixture, borrower: { entityId?: string; clientId?: string }, assetId: string) => ({
  ...borrower, assetId, productId: fx.product, supplierId: fx.supplier, contractType: "INSTALMENT_SALE",
  depositCents: 17_250_000, balloonCents: 0, firstDueDate: addMonthsClamped(sastCalendarDate(new Date()), 2),
  preset: { kind: "MONTHLY", periods: 60 }, rateBasis: "PRIME", rateMargin: "0.0100",
})

export interface DealerDraft {
  entityId: string
  directorId: string
  assetId: string
  dealId: string
}

/** A company, its director and an asset captured by `actor`, and the DRAFT deal on them. */
export async function dealerDraft(fx: DealerFixture, actor: DealerActor): Promise<DealerDraft> {
  return inTenant(fx, async () => {
    const entityId = createdId(await captureDealerEntity(actor, companyBody()))
    const directorId = createdId(await captureDealerPerson(actor, personBody(), entityId))
    const assetId = createdId(await captureDealerAsset(actor, assetBody()))
    const deal = await createDealerDeal(actor, dealBody(fx, { entityId }, assetId))
    if (deal.kind !== "created") throw new Error(`deal not created: ${JSON.stringify(deal)}`)
    return { entityId, directorId, assetId, dealId: deal.dealId }
  })
}

/** A synthetic one-page "PDF" upload of `docType`. */
export function pdfUpload(docType: ParsedEntityUpload["docType"]): ParsedEntityUpload {
  const file = new File([Buffer.from(`%PDF-1.4\n% synthetic ${docType}`)], `${docType.toLowerCase()}.pdf`, { type: "application/pdf" })
  return { file, docType, dealId: null }
}
