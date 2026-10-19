/**
 * Solve a deal structure for a preview, writing nothing: the asset's cash
 * price, the tenant's reference rate, the solver, and for a lease the rental
 * schedule with VAT at the rate in force on the commencement date; for a
 * known NCA borrower the NCA structure and its caps. A structure that cannot
 * be solved is an answer about the input (200 with `{ error }`), not a failed
 * request. The one copy behind both previews: staff POST
 * /api/asset-finance/deals/preview and the dealer portal
 * (app/api/dealer/deals/preview), which checks first that the asset is the
 * dealer's own.
 */
import { prisma } from "@/lib/prisma"
import { loadRateOn, NoVatRateError } from "@/lib/vat/vat-rate"
import type { DealPreviewInput } from "./deal-input"
import { solveWithRate, type AssetPrice } from "./deal-structure"
import { NCA_ASSET_CAPS, resolvedAssetFinanceNcaCapProblems } from "./nca-caps"
import { solveNcaDealStructure } from "./nca-structure"
import { isLeaseTerms, priceLeaseTerms } from "./lease-structure"
import { isLeaseContract } from "./lease-input"
import { leaseScheduleView } from "./lease-view"

export type DealPreviewAnswer = { status: 200 | 400; body: Record<string, unknown> }

export async function previewDealStructure(tenantId: string, input: DealPreviewInput, asset: AssetPrice): Promise<DealPreviewAnswer> {
  const answer = (body: Record<string, unknown>, status: 200 | 400 = 200): DealPreviewAnswer => ({ status, body })
  const genericSolved = await solveWithRate(prisma, tenantId, asset, input.terms)
  if (!genericSolved.ok) return answer({ error: genericSolved.error })
  const { terms, contractType } = input
  if (isLeaseTerms(terms)) {
    const vat = await loadRateOn(prisma, genericSolved.startDate).catch((error: unknown) => {
      if (error instanceof NoVatRateError) return null
      throw error
    })
    if (!vat) return answer({ error: `No VAT rate is in force on ${genericSolved.startDate}` })
    const priced = priceLeaseTerms(asset, terms, genericSolved.rate, genericSolved.startDate, vat.rateTenThousandths)
    if (!priced.ok) return answer({ error: priced.error })
    return answer({
      startDate: priced.startDate, termDays: priced.termDays, rate: priced.rate, weights: terms.weights,
      ...priced.result, lease: leaseScheduleView(priced.lease, vat.rate),
    })
  }
  if (isLeaseContract(contractType)) return answer({ error: "A lease needs its lease terms" }, 400)
  const solved = input.nca ? solveNcaDealStructure(asset, terms, genericSolved.rate, genericSolved.startDate) : genericSolved
  if (!solved.ok) return answer({ error: solved.error })
  if (input.nca) {
    const problems = await resolvedAssetFinanceNcaCapProblems(prisma, tenantId, solved.startDate, {
      contractType,
      annualRate: Number(solved.rate.annualRate),
      principalCents: solved.result.financedAmountCents,
      initiationFeeCents: terms.financedFeesCents,
      monthlyServiceFeeCents: NCA_ASSET_CAPS.monthlyServiceFeeCents,
    })
    if (problems === null) return answer({ error: "No approved REPO rate exists for the NCA cap on the deal start date" })
    if (problems.length > 0) return answer({ error: problems[0].message })
  }
  return answer({ startDate: solved.startDate, termDays: solved.termDays, rate: solved.rate, weights: terms.weights, ...solved.result })
}
