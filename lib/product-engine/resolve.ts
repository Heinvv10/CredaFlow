/**
 * What an application is priced and scheduled on: the version of its product in effect on the day, and the one pricing rule
 * that matches (pricing.ts). A product with no version in effect is not under the engine: callers keep their existing
 * behaviour and nothing here changes it.
 */
import type { prisma } from "@/lib/prisma"
import { dbDate } from "@/lib/asset-finance/dates"
import type { RepaymentTerms } from "./types"
import { repaymentTermsFor, type ProductConfig } from "./terms"
import { resolvePricing, type PricingContext, type PricingRule, type ResolvedPricing } from "./pricing"

type Db = Pick<typeof prisma, "productVersion" | "productPricingRule" | "applicationPricingInput">

export interface VersionRecord {
  id: string
  productId: string
  version: number
  /** SAST day. */
  effectiveFrom: string
  config: ProductConfig
}

const day = (d: Date) => d.toISOString().slice(0, 10)

type VersionRow = NonNullable<Awaited<ReturnType<Db["productVersion"]["findFirst"]>>>

export function versionFromRow(row: VersionRow): VersionRecord {
  return {
    id: row.id, productId: row.productId, version: row.version, effectiveFrom: day(row.effectiveFrom),
    config: {
      minAmountCents: row.minAmount, maxAmountCents: row.maxAmount, minTermDays: row.minTermDays, maxTermDays: row.maxTermDays,
      interestRatePm: row.interestRatePm, interestModel: row.interestModel, initiationFeeModel: row.initiationFeeModel,
      initiationFeePct: row.initiationFeePct, initiationFeeMaxCents: row.initiationFeeMax, monthlyServiceFeeCents: row.monthlyServiceFee,
      repayment: row.frequency && row.structure && row.graceKind
        ? { frequency: row.frequency, structure: row.structure, graceKind: row.graceKind, graceInstalments: row.graceInstalments }
        : null,
      collateral: row.collateral as unknown as ProductConfig["collateral"],
      eligibility: row.eligibility as unknown as ProductConfig["eligibility"],
    },
  }
}

/** The latest version of the product with effectiveFrom on or before `asOf` (a SAST day), or null. */
export async function loadEffectiveVersion(db: Pick<Db, "productVersion">, tenantId: string, productId: string, asOf: string): Promise<VersionRecord | null> {
  const row = await db.productVersion.findFirst({
    where: { tenantId, productId, effectiveFrom: { lte: dbDate(asOf) } },
    orderBy: { effectiveFrom: "desc" },
  })
  return row ? versionFromRow(row) : null
}

/** The pricing rules of a product (or of all) that are not retired and are valid on `asOf`. */
export async function loadPricingRules(db: Pick<Db, "productPricingRule">, tenantId: string, productId: string, asOf: string): Promise<PricingRule[]> {
  const rows = await db.productPricingRule.findMany({
    where: {
      tenantId, retiredAt: null, validFrom: { lte: dbDate(asOf) }, AND: [{ OR: [{ validTo: null }, { validTo: { gte: dbDate(asOf) } }] }, { OR: [{ productId: null }, { productId }] }],
    },
  })
  return rows.map((r) => ({
    id: r.id, productId: r.productId, name: r.name, segment: r.segment, channel: r.channel, riskRankMin: r.riskRankMin, riskRankMax: r.riskRankMax,
    campaignCode: r.campaignCode, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null, priority: r.priority,
    rate: { mode: r.rateMode as "SET" | "ADD", value: r.rateValue }, initiationFeePct: r.initiationFeePct, createdAt: r.createdAt.toISOString(),
  }))
}

export interface PricedTerms {
  version: VersionRecord
  pricing: ResolvedPricing
  /** The product's own rate and fee share, before any rule. */
  base: { ratePm: number; initiationFeePct: number }
  /** What the rule was matched on. */
  inputs: { segment: string | null; channel: string | null; campaignCode: string | null; riskRank: number | null }
  /** The engine's terms for this loan's term, or null when the version keeps the product's existing behaviour. */
  repayment: RepaymentTerms | null
}

/**
 * The terms an application is approved on, or null when its product has no version in effect. `riskRank` is the
 * application's grade rank (lib/decisioning/risk-grade.ts, null = not graded).
 */
export async function priceApplication(
  db: Db,
  tenantId: string,
  args: { productId: string; applicationId: string; riskRank: number | null; termDays: number; asOf: string },
): Promise<PricedTerms | null> {
  const version = await loadEffectiveVersion(db, tenantId, args.productId, args.asOf)
  if (!version) return null
  const input = await db.applicationPricingInput.findFirst({ where: { tenantId, applicationId: args.applicationId } })
  const inputs = { segment: input?.segment ?? null, channel: input?.channel ?? null, campaignCode: input?.campaignCode ?? null, riskRank: args.riskRank }
  const ctx: PricingContext = { productId: args.productId, ...inputs, asOf: args.asOf }
  const base = { ratePm: version.config.interestRatePm, initiationFeePct: version.config.initiationFeePct }
  const pricing = resolvePricing(await loadPricingRules(db, tenantId, args.productId, args.asOf), ctx, base)
  return {
    version, pricing, base, inputs,
    repayment: version.config.repayment ? repaymentTermsFor(version.config.repayment, args.termDays) : null,
  }
}
