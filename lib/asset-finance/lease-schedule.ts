// A lease's rental schedule with VAT at the rate in force on its commencement
// date: the one calculation behind the staff deal page and the lease
// agreement (./documents/lease/lease-document-data.ts), on the pricing the
// create preview runs (./lease-structure.ts priceLeaseTerms, ./lease-view.ts).
//
// START DATE. Once the documents are prepared the agreement prints the
// rentals from the planned start chosen then (plannedStartDate), so the deal
// page does too; before that it shows the indicative commencement.
import type { VatTransaction } from "@/lib/vat/db"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import { leaseEndDate, leaseStartDate, priceLeaseTerms, type LeaseTermsOf } from "./lease-structure"
import { leaseScheduleView, type LeaseScheduleView } from "./lease-view"
import { resolveRate, type AssetPrice, type ResolvedRate } from "./deal-structure"
import type { RatesDb } from "./rates-store"

export type PricedLeaseSchedule =
  | { ok: true; schedule: LeaseScheduleView; startDate: string; endDate: string }
  | { ok: false; reason: "vat" | "pricing" | "rate"; error: string }

export async function pricedLeaseSchedule(
  db: Pick<VatTransaction, "vatRate">,
  asset: AssetPrice,
  terms: LeaseTermsOf,
  rate: ResolvedRate,
  startDate: string,
): Promise<PricedLeaseSchedule> {
  const vat = await loadRateOn(db, startDate).catch((error: unknown) => {
    if (error instanceof NoVatRateError) return error
    throw error
  })
  if (vat instanceof NoVatRateError) return { ok: false, reason: "vat", error: vat.message }
  const priced = priceLeaseTerms(asset, terms, rate, startDate, vat.rateTenThousandths)
  if (!priced.ok) return { ok: false, reason: "pricing", error: priced.error }
  return { ok: true, schedule: leaseScheduleView(priced.lease, vat.rate), startDate, endDate: leaseEndDate(terms, startDate) }
}

export type DealLeaseSchedule = PricedLeaseSchedule & { prepared: boolean; rate: ResolvedRate | null }

/** The deal page's rentals: from the prepared start date when there is one, else the indicative commencement. */
export async function dealLeaseSchedule(
  db: RatesDb & Pick<VatTransaction, "vatRate">,
  tenantId: string,
  asset: AssetPrice,
  terms: LeaseTermsOf,
  plannedStartDate: string | null,
): Promise<DealLeaseSchedule> {
  const prepared = plannedStartDate !== null
  const startDate = plannedStartDate ?? leaseStartDate(terms)
  const rate = await resolveRate(db, tenantId, terms.rate, startDate)
  if ("error" in rate) return { ok: false, reason: "rate", error: rate.error, prepared, rate: null }
  return { ...(await pricedLeaseSchedule(db, asset, terms, rate, startDate)), prepared, rate }
}
