/**
 * The terms an application is approved on. For a product with no version in effect they are the product row's own, exactly
 * as before; for one under the engine they are the version in effect's, with the price the one matching pricing rule gives
 * (resolve.ts), and the repayment structure. Approval (decide-application.ts, current-approval.ts) calls this once for the
 * calculation and the stored inputs, so the schedule, the evidence and the booked loan agree; a loan is then booked on the
 * inputs frozen at approval (lib/affordability/snapshot.ts calculateLoanFromDecisionInputs), never on a later version.
 */
import type { LoanCalcInput } from "@/lib/loan-calculator"
import type { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isMicro30Code } from "@/lib/product-config/micro30"
import { priceApplication } from "./resolve"
import { assertValidTerms } from "./schedule"
import { versionNcaIssues } from "./nca"
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
  /** The limits of the version in effect, which an approval's amount and term must be within; null for a product with no version. */
  limits: { minAmountCents: number; maxAmountCents: number; minTermDays: number; maxTermDays: number } | null
  /**
   * Why an NCA lender may not approve a loan on this version, or []: the whole gate the version was approved under and activation
   * runs (versionNcaIssues), checked again now, because the process may have been configured differently when it was approved.
   */
  ncaIssues: string[]
}

/** The terms of an application whose product row is `product`, on the SAST day `asOf`. */
export async function approvalTermsFor(
  db: Db,
  tenantId: string,
  application: { id: string; productId: string; appliedTermDays: number; riskGradeRank: number | null },
  product: ProductPricing & { code?: string; productType?: string },
  asOf: string = sastCalendarDate(new Date()),
): Promise<ApprovalTerms> {
  const priced = await priceApplication(db, tenantId, { productId: application.productId, applicationId: application.id, riskRank: application.riskGradeRank, termDays: application.appliedTermDays, asOf, useRules: !isMicro30Code(product.code) })
  if (!priced) return { ...pickPricing(product), repayment: null, versioned: null, limits: null, ncaIssues: [] }
  const c = priced.version.config
  return {
    interestRatePm: priced.pricing.ratePm, interestModel: c.interestModel, initiationFeeModel: c.initiationFeeModel, initiationFeePct: priced.pricing.initiationFeePct,
    initiationFeeMax: c.initiationFeeMaxCents, monthlyServiceFee: c.monthlyServiceFeeCents,
    repayment: priced.repayment,
    // The gate activation runs (structure, fee, cap, the MICRO30 contract), so a version one refuses cannot pass the other.
    ncaIssues: await versionNcaIssues(tenantId, { code: product.code ?? "", productType: product.productType ?? "" }, c),
    limits: { minAmountCents: c.minAmountCents, maxAmountCents: c.maxAmountCents, minTermDays: c.minTermDays, maxTermDays: c.maxTermDays },
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
 * `application` as the NCA interest-rate cap must see it for a loan on `terms`: the rate and basis the loan is WRITTEN at, not
 * the product row's, and the principal and term it is approved for. Whenever a version is in effect those are the version's
 * (with its pricing rule's price, if one matched), so the cap is checked on them, rule or no rule: a version approved under
 * an earlier repo rate, or one not yet written through to the product row, may price a loan above today's ceiling.
 * Hand the result to approvalInterestCapRefusal / approvalInterestCapCheck (lib/loan/nca-interest-cap.server.ts), which keep
 * the NON_NCA and jurisdiction exemptions and the repeat short-term rule. A loan is refused, never re-priced.
 */
export function capApplicationFor<A extends { appliedAmount: number; appliedTermDays: number; product: { interestRatePm: number; interestModel: string } }>(
  application: A,
  terms: ApprovalTerms,
  loan: { principalCents: number; termDays: number },
): A {
  return { ...application, appliedAmount: loan.principalCents, appliedTermDays: loan.termDays, product: { ...application.product, interestRatePm: terms.interestRatePm, interestModel: terms.interestModel } }
}

/**
 * The calculator input for an application as staff see it before it is decided (the affordability assessment, the application
 * page, the decision engine's facts): the product's terms as approval will use them (approvalTermsFor), so a versioned
 * product's rate, fees and repayment structure are the ones shown and assessed, not the product row's legacy schedule.
 */
export async function previewCalcInput(
  db: Db,
  tenantId: string,
  application: { id: string; productId: string; appliedAmount: number; appliedTermDays: number; riskGradeRank: number | null; initiationFeePayment: "DEFERRED" | "UPFRONT" },
  product: ProductPricing & { productType: string; code?: string },
  asOf: string = sastCalendarDate(new Date()),
): Promise<LoanCalcInput> {
  const terms = await approvalTermsFor(db, tenantId, application, product, asOf)
  return {
    principal: application.appliedAmount,
    termDays: application.appliedTermDays,
    interestRatePm: terms.interestRatePm,
    productType: product.productType,
    interestModel: terms.interestModel,
    initiationFeeModel: terms.initiationFeeModel,
    initiationFeePct: terms.initiationFeePct,
    initiationFeeMax: terms.initiationFeeMax,
    monthlyServiceFee: terms.monthlyServiceFee,
    initiationFeePayment: application.initiationFeePayment,
    ...(terms.repayment ? { repayment: terms.repayment } : {}),
  }
}

/** Why a loan of this principal and term is outside the version's limits (or its structure cannot schedule it), or null. */
export function versionLimitRefusal(terms: ApprovalTerms, loan: { principalCents: number; termDays: number }): string | null {
  const l = terms.limits
  if (l) {
    if (loan.principalCents < l.minAmountCents || loan.principalCents > l.maxAmountCents) return `the amount is outside the product version's limits of ${l.minAmountCents} to ${l.maxAmountCents} cents`
    if (loan.termDays < l.minTermDays || loan.termDays > l.maxTermDays) return `the term is outside the product version's limits of ${l.minTermDays} to ${l.maxTermDays} days`
  }
  if (terms.repayment) {
    try {
      assertValidTerms(terms.repayment)
    } catch (error) {
      return `the product version's repayment structure cannot schedule this term: ${error instanceof Error ? error.message : "invalid"}`
    }
  }
  return null
}
