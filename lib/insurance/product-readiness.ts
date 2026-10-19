// The underwriting gate: may this product be sold at all?
//
// The insurer arrangement is not yet signed, so no product has real terms. This
// function is what keeps the module dark until they exist: even with
// `featureIms` on, nothing may be quoted or sold until a real rate card and the
// insurer's mandatory acceptance terms have been captured through the
// backoffice.
//
// It FAILS CLOSED. A thrown error — a dropped connection, a malformed
// configured value — yields `sellable: false` with the error as a reason, never
// an optimistic true. The cost of a false negative is a product that cannot be
// sold until someone looks; the cost of a false positive is selling cover on
// terms no insurer agreed to.

import type { InsuredLifeType, PrismaClient } from "@prisma/client"
import type { EligibilityRuleInput } from "./eligibility/evaluate"
import { mandatoryRuleStatus } from "./eligibility/mandatory-status"
import { loadEligibilityRules } from "./eligibility/rules"
import { INSURED_LIFE_TYPES, lifeTypesWithBands } from "./rating/band-match"
import { resolveActiveRateTable } from "./rating/rate-table"

/**
 * Every life type a quote can carry. Defined next to the band-matching rule it
 * is used with and re-exported here, because this module's test is the one that
 * compares it against the Prisma enum. Hand-written for the same reason
 * `ALL_RULE_TYPES` is.
 */
export { INSURED_LIFE_TYPES }

export interface CanSellProductParams {
  tenantId: string
  productId: string
  /** The instant readiness is asked about. Caller-supplied, never `new Date()` here. */
  at: Date
}

export interface ProductReadiness {
  sellable: boolean
  /** Empty exactly when `sellable` is true. Each entry names one missing thing. */
  reasons: string[]
}

/**
 * The rule and coverage half of readiness, pure: mandatory terms resolved per
 * life type, and every screenable life type needing a band on the card.
 * `bands` is null when there is no usable card (that reason is the caller's).
 * Shared with the catalogue headline so the two cannot disagree on "sellable".
 */
export function ruleAndCoverageReasons(
  rules: EligibilityRuleInput[],
  bands: readonly { lifeType: InsuredLifeType }[] | null,
): string[] {
  const reasons: string[] = []
  /** Life types no mandatory rule leaves unresolved — the ones a quote can screen. */
  const screenable = new Set(INSURED_LIFE_TYPES)

  // Resolved through evaluate's OWN resolver, per life type — see
  // `mandatory-status.ts`, which is the single implementation of both the
  // resolution and the sentence. Counting any valued row of the type ignored
  // lifeScope and disagreed with the screen: a product whose only MAX_COVER
  // row was CHILD-scoped reported sellable while every MAIN_MEMBER life
  // screened NOT_CONFIGURED. The rule-editor screen renders the same result,
  // so an operator is never told a term is captured that screening does not
  // resolve.
  for (const { unresolved, reason } of mandatoryRuleStatus(rules)) {
    for (const lifeType of unresolved) screenable.delete(lifeType)
    if (reason) reasons.push(reason)
  }

  // SELLABLE MUST MEAN QUOTABLE. Screening the rules and stopping there let a
  // card with one MAIN_MEMBER band and complete ALL_LIVES rules report
  // sellable with no reasons, while a SPOUSE on that product quoted
  // NO_MATCHING_BAND: `resolveActiveRateTable` asserts only that the card has
  // SOME band, and that one did.
  //
  // The rule: a life type this product SCREENS as eligible must be one its
  // rate card can PRICE. Life type is the single key every basis matches on
  // (see `band-match.ts`), so "the card carries a band for it" is exactly the
  // condition under which `rateLife` can return anything but NO_MATCHING_BAND
  // — which is why readiness and rating cannot drift here.
  //
  // Only SCREENABLE life types are reported. One already blocked for missing
  // rules is one product fault, not two.
  if (bands) {
    const priceable = new Set(lifeTypesWithBands(bands))
    const unpriceable = [...screenable].filter((lifeType) => !priceable.has(lifeType))
    if (unpriceable.length > 0) {
      reasons.push(
        `The ACTIVE rate table has no band for ${unpriceable.join(", ")}, so those lives screen as eligible but cannot be priced`,
      )
    }
  }
  return reasons
}

type ReadinessReader = Pick<PrismaClient, "insuranceRateTable" | "insuranceEligibilityRule">

export async function canSellProduct(
  prisma: ReadinessReader,
  params: CanSellProductParams,
): Promise<ProductReadiness> {
  const reasons: string[] = []

  try {
    const rateTable = await resolveActiveRateTable(prisma, params)
    if (!rateTable.ok) {
      // resolveActiveRateTable already distinguishes "none configured", "two
      // in force" and "in force but empty" — all three block a sale.
      reasons.push(rateTable.detail)
    }

    const rules = await loadEligibilityRules(prisma, params)
    reasons.push(...ruleAndCoverageReasons(rules, rateTable.ok ? rateTable.table.bands : null))
  } catch (error) {
    // Fail closed: an unreadable configuration is an unsellable product.
    return {
      sellable: false,
      reasons: [`Product readiness could not be determined: ${(error as Error).message}`],
    }
  }

  return { sellable: reasons.length === 0, reasons }
}
