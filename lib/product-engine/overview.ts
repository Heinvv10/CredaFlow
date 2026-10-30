import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { presentChangeRequest } from "@/lib/maker-checker/http"
import { listChangeRequests } from "@/lib/maker-checker/service"
import { PRODUCT_VERSION_KIND } from "./change-handlers"
import { PRICING_RULE_KIND } from "./pricing"
import { versionFromRow, type VersionRecord } from "./resolve"

export type VersionStatus = "IN_EFFECT" | "SCHEDULED" | "SUPERSEDED"

/** Everything the product versions page shows, for one lender. Plain JSON: dates are strings. */
export async function loadProductEngineOverview(tenantId: string, viewer: { id: string; role: string }) {
  const today = sastCalendarDate(new Date())
  const [products, versionRows, rules, requests] = await Promise.all([
    prisma.loanProduct.findMany({
      where: { tenantId, productType: { not: "ASSET_FINANCE" } }, orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, productType: true, active: true, minAmount: true, maxAmount: true, minTermDays: true, maxTermDays: true, interestRatePm: true, interestModel: true, initiationFeeModel: true, initiationFeePct: true, initiationFeeMax: true, monthlyServiceFee: true },
    }),
    prisma.productVersion.findMany({ where: { tenantId }, orderBy: [{ productId: "asc" }, { version: "desc" }] }),
    prisma.productPricingRule.findMany({ where: { tenantId }, orderBy: [{ retiredAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }] }),
    listChangeRequests(tenantId, { kinds: [PRODUCT_VERSION_KIND, PRICING_RULE_KIND], recentDays: 14, limit: 100 }).then((page) => page.rows),
  ])
  const inEffect = new Map<string, string>()
  for (const row of [...versionRows].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())) {
    if (row.effectiveFrom.toISOString().slice(0, 10) <= today && !inEffect.has(row.productId)) inEffect.set(row.productId, row.id)
  }
  const versions = versionRows.map((row) => {
    const record: VersionRecord = versionFromRow(row)
    const status: VersionStatus = inEffect.get(row.productId) === row.id ? "IN_EFFECT" : record.effectiveFrom > today ? "SCHEDULED" : "SUPERSEDED"
    return { id: row.id, productId: row.productId, version: row.version, effectiveFrom: record.effectiveFrom, status, reason: row.reason, config: record.config, createdAt: row.createdAt.toISOString() }
  })
  return {
    today,
    nca: isNcaJurisdiction(),
    products,
    versions,
    rules: rules.map((r) => ({
      id: r.id, productId: r.productId, name: r.name, segment: r.segment, channel: r.channel, riskRankMin: r.riskRankMin, riskRankMax: r.riskRankMax, campaignCode: r.campaignCode,
      validFrom: r.validFrom.toISOString().slice(0, 10), validTo: r.validTo ? r.validTo.toISOString().slice(0, 10) : null, priority: r.priority,
      rate: { mode: r.rateMode as "SET" | "ADD", value: r.rateValue }, initiationFeePct: r.initiationFeePct, retired: r.retiredAt !== null,
    })),
    requests: requests.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((r) => presentChangeRequest(r, viewer.id, viewer.role)),
  }
}

export type ProductEngineOverview = Awaited<ReturnType<typeof loadProductEngineOverview>>
