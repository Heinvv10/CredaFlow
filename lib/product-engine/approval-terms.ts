/**
 * The terms an application is approved on. For a product with no version in effect they are the product row's own, exactly
 * as before; for one under the engine they are the version in effect's, with the price the one matching pricing rule gives
 * (resolve.ts), and the repayment structure. Approval (decide-application.ts, current-approval.ts) calls this once for the
 * calculation and the stored inputs, so the schedule, the evidence and the booked loan agree; a loan is then booked on the
 * inputs frozen at approval (lib/affordability/snapshot.ts calculateLoanFromDecisionInputs), never on a later version.
 */
import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { pricedRateRefusal } from "./nca"
import { priceApplication } from "./resolve"
import type { RepaymentTerms } from "./types"

type Db = Pick<typeof prisma, "productVersion" | "productPricingRule" | "applicationPricingInput">

export interface ProductPricing {
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
}

export interface VersionedTerms {
  productVersionId: string
  version: number
  /** The product's rate before any rule. */
  baseRatePm: number
  pricingRuleId: string | null
  pricingRuleName: string | null
  pricingInputs: { segment: string | null; channel: string | null; campaignCode: string | null; riskRank: number | null }
}

export interface ApprovalTerms extends ProductPricing {
  repayment: RepaymentTerms | null
  /** Null for a product with no version in effect. */
  versioned: VersionedTerms | null
}

/** The terms of an application whose product row is `product`, on the SAST day `asOf`. */
export async function approvalTermsFor(
  db: Db,
  tenantId: string,
  application: { id: string; productId: string; appliedTermDays: number; riskGradeRank: number | null },
  product: ProductPricing,
  asOf: string = sastCalendarDate(new Date()),
): Promise<ApprovalTerms> {
  const priced = await priceApplication(db, tenantId, { productId: application.productId, applicationId: application.id, riskRank: application.riskGradeRank, termDays: application.appliedTermDays, asOf })
  if (!priced) return { ...pickPricing(product), repayment: null, versioned: null }
  const c = priced.version.config
  return {
    interestRatePm: priced.pricing.ratePm, interestModel: c.interestModel, initiationFeeModel: c.initiationFeeModel, initiationFeePct: priced.pricing.initiationFeePct,
    initiationFeeMax: c.initiationFeeMaxCents, monthlyServiceFee: c.monthlyServiceFeeCents,
    repayment: priced.repayment,
    versioned: {
      productVersionId: priced.version.id, version: priced.version.version, baseRatePm: priced.base.ratePm,
      pricingRuleId: priced.pricing.ruleId, pricingRuleName: priced.pricing.ruleName, pricingInputs: priced.inputs,
    },
  }
}

const pickPricing = (p: ProductPricing): ProductPricing => ({
  interestRatePm: p.interestRatePm, interestModel: p.interestModel, initiationFeeModel: p.initiationFeeModel, initiationFeePct: p.initiationFeePct,
  initiationFeeMax: p.initiationFeeMax, monthlyServiceFee: p.monthlyServiceFee,
})

/**
 * The refusal when a price a RULE set (as opposed to the product's own rate, which the product configuration already holds to
 * the cap) is above the NCA ceiling for this loan, or null. A rule is checked when it is approved and again here, for the
 * loan's actual principal and term: a loan is refused, never re-priced.
 */
export async function ruledRateRefusal(tenantId: string, terms: ApprovalTerms, loan: { principalCents: number; termDays: number }): Promise<string | null> {
  if (!terms.versioned?.pricingRuleId) return null
  return pricedRateRefusal(tenantId, { ...loan, interestRatePm: terms.interestRatePm, interestModel: terms.interestModel })
}
