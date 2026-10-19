// The per-product headline price shown on catalogue cards and pickers.
//
// InsuranceProduct.premiumAmount is a flat column that QUOTING IGNORES for a
// product with a rate table, so showing it as "the" price quotes a client a
// different number than the one they are then charged. The headline therefore
// only claims a price and cover that quoting can actually produce: every
// candidate is priced with `rateLife` (the quoting module's own band matching,
// PER_MILLE arithmetic and non-positive refusal) and screened with `evaluate`
// (the insurer's eligibility rules), and the table is the one
// `inForceActiveTableWhere` selects. Money is integer cents throughout.

import type { Prisma } from "@prisma/client"
import { evaluate, type EligibilityRuleInput } from "./eligibility/evaluate"
import { resolveRule } from "./eligibility/rule-resolution"
import { activeEligibilityRulesForProductsFindManyArgs } from "./eligibility/rules"
import { ruleAndCoverageReasons } from "./product-readiness"
import { requiresRating } from "./policy/draft-rating-gate"
import { formatCents, toCents } from "./rand-cents"
import { inForceActiveTableWhere } from "./rating/rate-table"
import { rateLife, type RateBandInput } from "./rating/rate-quote"
import type { RateBasis } from "@prisma/client"

/**
 * flat:  no rate table in force; the product's own premium and cover apply.
 * from:  the cheapest price quoting can produce for a main member, with its cover.
 * quote: a rate table is in force but yields no quotable main-member price
 *        (none usable, or ambiguous tables). Never falls back to the flat price.
 */
export type Headline =
  | { kind: "flat" }
  | { kind: "from"; premiumCents: number; coverCents: number }
  | { kind: "quote" }

/** Smallest adult entry age; a child band is never the main-member headline. */
const MIN_ADULT_AGE = 18

interface TableForHeadline {
  basis: RateBasis
  bands: (RateBandInput & { sumAssured: string | { toFixed(n: number): string } })[]
}

function dateOfBirthForAge(age: number, at: Date): Date {
  // Day capped at 28 so a 29 Feb effective date cannot round the age down.
  return new Date(Date.UTC(at.getUTCFullYear() - age, at.getUTCMonth(), Math.min(at.getUTCDate(), 28)))
}

/** The youngest main member the insurer's MIN_ENTRY_AGE rule lets in, or 0 when none is set. */
function minEntryAgeRule(rules: EligibilityRuleInput[]): number {
  const resolved = resolveRule(rules, "MIN_ENTRY_AGE", "MAIN_MEMBER")
  return resolved.status === "OK" ? Number(resolved.numericValue.toString()) : 0
}

/**
 * Pure: the cheapest main-member price this table and these rules can quote.
 * "quote" unless the product is sellable by the same readiness the draft gate
 * uses (mandatory terms resolved, every screenable life type priceable).
 */
export function headlineForTable(table: TableForHeadline, rules: EligibilityRuleInput[], at: Date): Headline {
  if (table.bands.length === 0 || ruleAndCoverageReasons(rules, table.bands).length > 0) return { kind: "quote" }
  const floor = Math.max(MIN_ADULT_AGE, minEntryAgeRule(rules))
  let best: { premiumCents: number; coverCents: number } | null = null
  for (const band of table.bands) {
    if (band.lifeType !== "MAIN_MEMBER") continue
    // Probe the youngest age both the band and the insurer admit.
    const age = Math.max(band.minAge, floor)
    if (age > band.maxAge) continue
    const coverCents = toCents(band.sumAssured)
    if (coverCents <= 0) continue
    const rated = rateLife(table.bands, table.basis, "MAIN_MEMBER", age, band.sumAssured)
    if (!rated.ok) continue
    const screened = evaluate({
      rules,
      lives: [{ ref: "headline", lifeType: "MAIN_MEMBER", dateOfBirth: dateOfBirthForAge(age, at), sumAssured: formatCents(coverCents) }],
      effectiveDate: at,
    })
    if (!screened.pass) continue
    const better =
      best === null ||
      rated.premiumCents < best.premiumCents ||
      (rated.premiumCents === best.premiumCents && coverCents < best.coverCents)
    if (better) best = { premiumCents: rated.premiumCents, coverCents }
  }
  return best ? { kind: "from", ...best } : { kind: "quote" }
}

/** The query, exposed so it is assertable without a database. */
export function headlineRateTablesFindManyArgs(tenantId: string, productIds: string[], at: Date) {
  return {
    where: inForceActiveTableWhere(tenantId, { in: productIds }, at),
    select: {
      productId: true,
      basis: true,
      bands: { select: { id: true, lifeType: true, minAge: true, maxAge: true, sumAssured: true, premiumAmount: true } },
    },
  } satisfies Prisma.InsuranceRateTableFindManyArgs
}

interface HeadlineReader {
  insuranceRateTable: {
    findMany(args: ReturnType<typeof headlineRateTablesFindManyArgs>): PromiseLike<(TableForHeadline & { productId: string })[]>
  }
  insuranceEligibilityRule: {
    findMany(
      args: ReturnType<typeof activeEligibilityRulesForProductsFindManyArgs>,
    ): PromiseLike<(EligibilityRuleInput & { productId: string })[]>
  }
}

/**
 * Headline per product, from the in-force ACTIVE rate table quoting would use.
 * Two queries for the whole catalogue (tables, then rules), grouped in memory.
 * A rated type with no table is "quote": the draft gate refuses it
 * (PRODUCT_NOT_SELLABLE), so the flat price would be one nobody can buy.
 */
export async function loadHeadlines(
  prisma: HeadlineReader,
  tenantId: string,
  products: { id: string; type: string }[],
  at: Date = new Date(),
): Promise<Map<string, Headline>> {
  const out = new Map<string, Headline>()
  if (products.length === 0) return out
  const ids = products.map((p) => p.id)
  const [tables, rules] = await Promise.all([
    prisma.insuranceRateTable.findMany(headlineRateTablesFindManyArgs(tenantId, ids, at)),
    prisma.insuranceEligibilityRule.findMany(activeEligibilityRulesForProductsFindManyArgs(tenantId, ids)),
  ])
  for (const { id, type } of products) {
    const own = tables.filter((t) => t.productId === id)
    if (own.length === 0) out.set(id, requiresRating(type) ? { kind: "quote" } : { kind: "flat" })
    else if (own.length > 1) out.set(id, { kind: "quote" }) // quoting: AMBIGUOUS_ACTIVE_TABLES
    else out.set(id, headlineForTable(own[0], rules.filter((r) => r.productId === id), at))
  }
  return out
}
