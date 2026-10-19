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
import { activeEligibilityRulesFindManyArgs } from "./eligibility/rules"
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

/** Pure: the cheapest main-member price this table and these rules can quote. */
export function headlineForTable(table: TableForHeadline, rules: EligibilityRuleInput[], at: Date): Headline {
  let best: { premiumCents: number; coverCents: number } | null = null
  for (const band of table.bands) {
    if (band.lifeType !== "MAIN_MEMBER") continue
    const age = Math.max(band.minAge, MIN_ADULT_AGE)
    if (age > band.maxAge) continue
    try {
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
    } catch {
      // Unparseable money on a band: quoting would refuse it, so it is not a candidate.
      continue
    }
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
    findMany(args: ReturnType<typeof activeEligibilityRulesFindManyArgs>): PromiseLike<EligibilityRuleInput[]>
  }
}

/** Headline per product id, from the in-force ACTIVE rate table quoting would use. */
export async function loadHeadlines(
  prisma: HeadlineReader,
  tenantId: string,
  productIds: string[],
  at: Date = new Date(),
): Promise<Map<string, Headline>> {
  const out = new Map<string, Headline>()
  if (productIds.length === 0) return out
  const tables = await prisma.insuranceRateTable.findMany(headlineRateTablesFindManyArgs(tenantId, productIds, at))
  for (const productId of productIds) {
    const own = tables.filter((t) => t.productId === productId)
    if (own.length === 0) out.set(productId, { kind: "flat" })
    else if (own.length > 1) out.set(productId, { kind: "quote" }) // quoting: AMBIGUOUS_ACTIVE_TABLES
    else out.set(productId, headlineForTable(own[0], await prisma.insuranceEligibilityRule.findMany(activeEligibilityRulesFindManyArgs({ tenantId, productId })), at))
  }
  return out
}
