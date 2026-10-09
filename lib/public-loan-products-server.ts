// SERVER-ONLY: imports prisma, so it must never be imported by a client component
// (the build would fail resolving node builtins). Server twin of the client
// fetchLivePricing()/useLivePricing() path — lets SERVER components that render
// marketing copy read the LIVE LoanProduct fee structure + ranges directly from
// the DB (no HTTP hop), fail-open to the static catalogue.

import { cache } from "react"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId } from "@/lib/tenant"
import {
  LOAN_PRODUCT_DB_CODE,
  applyLivePricing,
  publicLoanProducts,
  type LivePricing,
  type PublicLoanProduct,
  type PublicLoanProductCode,
} from "@/lib/public-loan-products"

// Reads active LoanProduct rows for the tenant and maps them to LivePricing keyed
// by PUBLIC code. Mirrors app/api/website/loan-pricing/route.ts EXACTLY (same
// select, case-insensitive code match, fail-open to {}), so the server-rendered
// copy and the client-fetched calculator can never diverge.
export async function getLivePricingServer(
  tenantId: string,
): Promise<Partial<Record<PublicLoanProductCode, LivePricing>>> {
  try {
    const rows = await prisma.loanProduct.findMany({
      where: { tenantId, active: true },
      select: {
        code: true,
        interestRatePm: true,
        interestModel: true,
        initiationFeeModel: true,
        initiationFeePct: true,
        initiationFeeMax: true,
        monthlyServiceFee: true,
        productType: true,
        minAmount: true,
        maxAmount: true,
        minTermDays: true,
        maxTermDays: true,
      },
    })
    const byDbCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]))
    const pricing: Partial<Record<PublicLoanProductCode, LivePricing>> = {}
    for (const [publicCode, dbCode] of Object.entries(LOAN_PRODUCT_DB_CODE) as [
      PublicLoanProductCode,
      string,
    ][]) {
      const row = byDbCode.get(dbCode.toLowerCase())
      if (!row) continue
      pricing[publicCode] = {
        interestRatePm: Number(row.interestRatePm),
        interestModel: row.interestModel as LivePricing["interestModel"],
        // Both of these are SELECTED above but were never copied across, so
        // every server-rendered marketing page silently fell back to the static
        // catalogue: the PO_FUNDING fee-cap exemption was lost, and a product
        // whose pricing model differs from the compile-time default published a
        // fee basis the engine does not use. Selecting a column is not reading
        // it. See the round-trip test in lib/__tests__.
        productType: row.productType,
        initiationFeeModel: row.initiationFeeModel,
        initiationFeePct: Number(row.initiationFeePct),
        initiationFeeMax: Number(row.initiationFeeMax),
        monthlyServiceFee: Number(row.monthlyServiceFee),
        minAmount: Number(row.minAmount),
        maxAmount: Number(row.maxAmount),
        minTermDays: row.minTermDays,
        maxTermDays: row.maxTermDays,
      }
    }
    return pricing
  } catch {
    // Fail-open: server copy falls back to the static catalogue.
    return {}
  }
}

// The live-overlaid public catalogue for SERVER components. Resolves the tenant
// via the RSC-safe getResolvedTenantId(); fail-open to the static catalogue so a
// dead DB never blanks a marketing page. Wrapped in React.cache so multiple
// callers in ONE render tree (e.g. the FAQ layout's JSON-LD + the FAQ page's
// visible copy) share a single DB read and therefore identical data — no
// cross-request caching, so admin edits still reflect next-load.
export const getLivePublicProductsServer = cache(async (): Promise<PublicLoanProduct[]> => {
  try {
    const tenantId = await getResolvedTenantId()
    const pricing = await getLivePricingServer(tenantId)
    return applyLivePricing(pricing)
  } catch {
    return publicLoanProducts
  }
})

// The public catalogue entries THIS tenant offers: only those with an active
// LoanProduct row, each carrying that row's live pricing and ranges. Empty when
// the tenant has none (or the read fails) — never the static snapshot, which
// describes another lender's products. For server-rendered product COPY (the
// home page, website chat knowledge); the interactive calculators keep the
// fail-open overlay above.
export const getTenantPublicProductsServer = cache(async (): Promise<PublicLoanProduct[]> => {
  const tenantId = await getResolvedTenantId()
  const pricing = await getLivePricingServer(tenantId)
  return applyLivePricing(pricing).filter((product) => pricing[product.code])
})
