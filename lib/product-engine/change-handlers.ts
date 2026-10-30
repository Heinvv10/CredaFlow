import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "@/lib/asset-finance/dates"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import { isMicro30Code } from "@/lib/product-config/micro30"
import { Problems, isDay, isObject, rejectUnknownKeys } from "@/lib/decisioning/validate-common"
import { activateDueVersions } from "./activate"
import { pricingRuleNcaIssue, versionNcaIssues } from "./nca"
import { PRICING_RULE_KIND, parsePricingRule, type PricingRulePayload } from "./pricing"
import { parseProductConfig, type ProductConfig } from "./terms"

export const PRODUCT_VERSION_KIND = "PRODUCT_VERSION"

/** A new version of a product's configuration: the whole of what the checker approves. The version number is assigned on approval. */
export interface ProductVersionPayload {
  productId: string
  /** SAST day YYYY-MM-DD; a day already past when approved starts on the approval day. */
  effectiveFrom: string
  reason: string
  config: ProductConfig
}

export function parseProductVersionPayload(raw: unknown): ProductVersionPayload {
  if (!isObject(raw)) throw new InvalidPayloadError(["payload: expected an object"])
  const problems = new Problems()
  rejectUnknownKeys(raw, ["productId", "effectiveFrom", "reason", "config"], "payload", problems)
  if (typeof raw.productId !== "string" || raw.productId.length === 0) problems.add("payload.productId", "the product this version is for")
  if (!isDay(raw.effectiveFrom)) problems.add("payload.effectiveFrom", "a date, YYYY-MM-DD")
  if (typeof raw.reason !== "string" || raw.reason.trim().length < 5 || raw.reason.length > 500) problems.add("payload.reason", "5 to 500 characters: why the product changes")
  let config: ProductConfig | null = null
  try {
    config = parseProductConfig(raw.config)
  } catch (error) {
    if (!(error instanceof InvalidPayloadError)) throw error
    for (const p of error.problems) problems.list.push(`payload.config.${p}`)
  }
  problems.throwIfAny()
  return { productId: raw.productId as string, effectiveFrom: raw.effectiveFrom as string, reason: (raw.reason as string).trim(), config: config! }
}

/**
 * What a rule is checked against: for every product it covers, the version in effect and every scheduled one (its limits and
 * rate are what loans will be priced from), or the product's own row when it has no version. A rule that covers every product
 * leaves out MICRO30, whose contract is fixed; one that names it is refused in the handler.
 */
async function productsInScope(tx: Tx, tenantId: string, productId: string | null, today: string) {
  const found = await tx.loanProduct.findMany({
    where: { tenantId, ...(productId ? { id: productId } : { active: true, productType: { not: "ASSET_FINANCE" } }) },
    select: { id: true, code: true, productType: true, maxAmount: true, maxTermDays: true, interestRatePm: true, interestModel: true },
  })
  // MICRO30 is left out of a rule for every product in code, not in the query: a code in other case or with spaces is the same product.
  const products = productId ? found : found.filter((p) => !isMicro30Code(p.code))
  const versions = await tx.productVersion.findMany({
    where: { tenantId, productId: { in: products.map((p) => p.id) } },
    orderBy: { effectiveFrom: "asc" },
    select: { productId: true, version: true, effectiveFrom: true, maxAmount: true, maxTermDays: true, interestRatePm: true, interestModel: true },
  })
  const todayDate = dbDate(today)
  return products.flatMap((p) => {
    const own = versions.filter((v) => v.productId === p.id)
    const inEffect = own.filter((v) => v.effectiveFrom <= todayDate).at(-1)
    const live = own.filter((v) => v === inEffect || v.effectiveFrom > todayDate)
    const fixedContract = isMicro30Code(p.code)
    return live.length === 0
      ? [{ ...p, fixedContract }]
      : live.map((v) => ({ id: p.id, code: `${p.code} v${v.version}`, fixedContract, productType: p.productType, maxAmount: v.maxAmount, maxTermDays: v.maxTermDays, interestRatePm: v.interestRatePm, interestModel: v.interestModel }))
  })
}

export const productVersionHandler: ChangeHandler<ProductVersionPayload> = {
  kind: PRODUCT_VERSION_KIND,
  label: "Product version",
  payloadVersion: 1,
  makePermission: "manage_product_versions",
  approvePermission: "approve_product_versions",
  parse: parseProductVersionPayload,
  async verify(tx: Tx, tenantId, payload) {
    const product = await tx.loanProduct.findFirst({ where: { id: payload.productId, tenantId }, select: { id: true, code: true, productType: true } })
    if (!product) throw new InvalidPayloadError(["payload.productId: that product does not exist"])
    // Asset finance has its own deals, valuations and caps; the product engine versions the lending products.
    if (product.productType === "ASSET_FINANCE") throw new InvalidPayloadError(["payload.productId: an asset-finance product is not versioned here"])
    const issues = await versionNcaIssues(tenantId, product, payload.config)
    if (issues.length > 0) throw new InvalidPayloadError(issues.map((i) => `payload.config.${i}`))
    const taken = await tx.productVersion.findFirst({ where: { tenantId, productId: payload.productId, effectiveFrom: dbDate(payload.effectiveFrom) }, select: { version: true } })
    if (taken) throw new InvalidPayloadError([`payload.effectiveFrom: version ${taken.version} already takes effect on ${payload.effectiveFrom}`])
  },
  // A version is drafted against the latest one of its product: if another is approved first, this one is stale.
  async baseRef(tx: Tx, tenantId, payload) {
    const latest = await tx.productVersion.aggregate({ where: { tenantId, productId: payload.productId }, _max: { version: true } })
    return `v${latest._max.version ?? 0}`
  },
  async apply(tx: Tx, { tenantId, request, payload, checker, now }) {
    const latest = await tx.productVersion.aggregate({ where: { tenantId, productId: payload.productId }, _max: { version: true } })
    const version = (latest._max.version ?? 0) + 1
    // A version cannot take effect in the past: a day already gone starts today.
    const today = sastCalendarDate(now)
    const effectiveFrom = payload.effectiveFrom < today ? today : payload.effectiveFrom
    const taken = await tx.productVersion.findFirst({ where: { tenantId, productId: payload.productId, effectiveFrom: dbDate(effectiveFrom) }, select: { version: true } })
    if (taken) throw new InvalidPayloadError([`payload.effectiveFrom: version ${taken.version} already takes effect on ${effectiveFrom}`])
    const c = payload.config
    const created = await tx.productVersion.create({
      data: {
        tenantId, productId: payload.productId, version, effectiveFrom: dbDate(effectiveFrom),
        minAmount: c.minAmountCents, maxAmount: c.maxAmountCents, minTermDays: c.minTermDays, maxTermDays: c.maxTermDays,
        interestRatePm: c.interestRatePm, interestModel: c.interestModel, initiationFeeModel: c.initiationFeeModel, initiationFeePct: c.initiationFeePct,
        initiationFeeMax: c.initiationFeeMaxCents, monthlyServiceFee: c.monthlyServiceFeeCents,
        frequency: c.repayment?.frequency ?? null, structure: c.repayment?.structure ?? null, graceKind: c.repayment?.graceKind ?? null,
        graceInstalments: c.repayment?.graceInstalments ?? 0,
        collateral: c.collateral as never, eligibility: c.eligibility as never, reason: payload.reason, changeRequestId: request.id,
      },
    })
    await logAuditStrict({
      tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.PRODUCT_VERSION_CREATED, entity: "ProductVersion", entityId: created.id,
      newValue: { productId: payload.productId, version, effectiveFrom, reason: payload.reason, interestRatePm: c.interestRatePm, repayment: c.repayment, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
    if (effectiveFrom <= today) await activateDueVersions(tx, tenantId, today, checker, now)
  },
}

export const pricingRuleHandler: ChangeHandler<PricingRulePayload> = {
  kind: PRICING_RULE_KIND,
  label: "Pricing rule",
  payloadVersion: 1,
  makePermission: "manage_product_versions",
  approvePermission: "approve_product_versions",
  parse: parsePricingRule,
  async verify(tx: Tx, tenantId, payload) {
    if (payload.action === "RETIRE") {
      const rule = await tx.productPricingRule.findFirst({ where: { id: payload.ruleId, tenantId }, select: { retiredAt: true } })
      if (!rule) throw new InvalidPayloadError(["payload.ruleId: no such pricing rule"])
      if (rule.retiredAt) throw new InvalidPayloadError(["payload.ruleId: that rule is already retired"])
      return
    }
    const products = await productsInScope(tx, tenantId, payload.rule.productId, sastCalendarDate(new Date()))
    if (payload.rule.productId && products.length === 0) throw new InvalidPayloadError(["payload.rule.productId: that product does not exist"])
    if (products.some((p) => p.productType === "ASSET_FINANCE")) throw new InvalidPayloadError(["payload.rule.productId: an asset-finance product is not priced here"])
    if (products.some((p) => p.fixedContract)) throw new InvalidPayloadError(["payload.rule.productId: the MICRO30 product has an approved fixed contract; no rule prices it"])
    const issue = await pricingRuleNcaIssue(tenantId, payload.rule.rate, products)
    if (issue) throw new InvalidPayloadError([`payload.rule.${issue}`])
  },
  async apply(tx: Tx, { tenantId, request, payload, checker }) {
    if (payload.action === "RETIRE") {
      const retired = await tx.productPricingRule.updateMany({ where: { id: payload.ruleId, tenantId, retiredAt: null }, data: { retiredAt: new Date(), retiredByRequestId: request.id } })
      if (retired.count !== 1) throw new InvalidPayloadError(["payload.ruleId: that rule is already retired"])
      await logAuditStrict({
        tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.PRODUCT_PRICING_RULE_RETIRED, entity: "ProductPricingRule", entityId: payload.ruleId,
        newValue: { changeRequestId: request.id, makerId: request.makerId },
      }, tx)
      return
    }
    const r = payload.rule
    const created = await tx.productPricingRule.create({
      data: {
        tenantId, productId: r.productId, name: r.name, segment: r.segment, channel: r.channel, riskRankMin: r.riskRankMin, riskRankMax: r.riskRankMax,
        campaignCode: r.campaignCode, validFrom: dbDate(r.validFrom), validTo: r.validTo ? dbDate(r.validTo) : null, priority: r.priority,
        rateMode: r.rate.mode, rateValue: r.rate.value, initiationFeePct: r.initiationFeePct, changeRequestId: request.id,
      },
    })
    await logAuditStrict({
      tenantId, userId: checker.id, userEmail: checker.email, action: AuditAction.PRODUCT_PRICING_RULE_CREATED, entity: "ProductPricingRule", entityId: created.id,
      newValue: { name: r.name, productId: r.productId, segment: r.segment, channel: r.channel, riskRank: [r.riskRankMin, r.riskRankMax], campaignCode: r.campaignCode, rate: r.rate, validFrom: r.validFrom, validTo: r.validTo, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
  },
}
