import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { LOAN_PRODUCT_DB_CODE, type PublicLoanProductCode, type LivePricing } from "@/lib/public-loan-products"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"

export const dynamic = "force-dynamic"

// Public, unauthenticated: returns ONLY the fee structure AND the amount/term
// ranges of the active loan products (the same figures already shown on the
// marketing site), keyed by the public product code. Lives under the
// /api/website/* prefix, which proxy.ts allowlists for unauthenticated marketing
// visitors (isWebsiteApi). The marketing calculator overlays this on its static
// catalogue so it reflects whatever the admin has configured at
// /settings/products/loan — no code deploy needed to change a rate, fee or range.
//
// LIVE read (no cache): the query is a handful of tenant-scoped, indexed rows,
// so an admin change is reflected on the next calculator load rather than after
// a cache window — the coupling the product owner asked for.
export async function GET(req: NextRequest) {
  try {
    const tenant = await getTenantFromRequest(req)
    if (!tenant) return NextResponse.json({ pricing: {} })

    const rows = await prisma.loanProduct.findMany({
      where: { tenantId: tenant.id, active: true, ...CONSUMER_PRODUCT_WHERE },
      select: {
        code: true,
        interestRatePm: true,
        interestModel: true,
        initiationFeeModel: true,
        initiationFeePct: true,
        productType: true,
        initiationFeeMax: true,
        monthlyServiceFee: true,
        minAmount: true,
        maxAmount: true,
        minTermDays: true,
        maxTermDays: true,
      },
    })
    // Match the product code case-INSENSITIVELY: the admin can edit the code at
    // /settings/products/loan (e.g. "Micro30" → "MICRO30"), and a case-only
    // change must not silently drop the product back to the static snapshot.
    const byDbCode = new Map(rows.map((r) => [r.code.toLowerCase(), r]))
    const pricing: Partial<Record<PublicLoanProductCode, LivePricing>> = {}
    for (const [publicCode, dbCode] of Object.entries(LOAN_PRODUCT_DB_CODE) as [PublicLoanProductCode, string][]) {
      const row = byDbCode.get(dbCode.toLowerCase())
      if (!row) continue
      pricing[publicCode] = {
        interestRatePm: Number(row.interestRatePm),
        interestModel: row.interestModel as LivePricing["interestModel"],
        initiationFeePct: Number(row.initiationFeePct),
      productType: row.productType,
        initiationFeeModel: row.initiationFeeModel,
        initiationFeeMax: Number(row.initiationFeeMax),
        monthlyServiceFee: Number(row.monthlyServiceFee),
        minAmount: Number(row.minAmount),
        maxAmount: Number(row.maxAmount),
        minTermDays: row.minTermDays,
        maxTermDays: row.maxTermDays,
      }
    }
    return NextResponse.json({ pricing })
  } catch {
    // The calculator falls back to its static catalogue on any error.
    return NextResponse.json({ pricing: {} })
  }
}
