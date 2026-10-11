/**
 * Proves the TypeScript credit-life premium equals the database's own formula
 * (`ROUND(principal::numeric * 0.0045)`, as used by pasq evidence validation)
 * on half-cent ties, where floating point rounds the wrong way.
 *
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_CREDIT_LIFE_PREMIUM_ROUNDING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-premium-rounding.integration.test.ts
 */
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { calculateCreditLifeMonthlyPremiumCents } from "@/lib/insurance/credit-life-election"

const suite = process.env.RUN_CREDIT_LIFE_PREMIUM_ROUNDING_IT === "1"
  ? describe
  : describe.skip

suite("credit-life premium rounding against Postgres", () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("matches the database formula on ties and a dense range", async () => {
    // Every 1000 cents from R1,000 to R500,000 (ties at odd multiples of 1000),
    // every cent in a window around known disagreement points, plus known ties.
    const rows = await prisma.$queryRawUnsafe<
      Array<{ principal: number; premium: number; rand_premium: string }>
    >(`
      WITH p(principal) AS (
        SELECT g::int FROM generate_series(100000, 50000000, 1000) g
        UNION SELECT g::int FROM generate_series(1338000, 1340000) g
        UNION SELECT g::int FROM generate_series(100000, 102000) g
        UNION SELECT unnest(ARRAY[101000, 1339000])
      )
      SELECT principal,
             ROUND(principal::NUMERIC * 0.0045)::INTEGER AS premium,
             ROUND((principal::NUMERIC / 100) * 0.0045, 2)::TEXT AS rand_premium
      FROM p ORDER BY principal
    `)
    expect(rows.length).toBeGreaterThan(50_000)

    const mismatches = rows.filter(
      (r) => calculateCreditLifeMonthlyPremiumCents(Number(r.principal)) !== Number(r.premium),
    )
    expect(mismatches.slice(0, 5)).toEqual([])
    // The rand-denominated policy check (assertBundledCreditLifePolicyTerms) agrees too.
    const randMismatches = rows.filter(
      (r) =>
        (calculateCreditLifeMonthlyPremiumCents(Number(r.principal)) / 100).toFixed(2)
          !== Number(r.rand_premium).toFixed(2),
    )
    expect(randMismatches.slice(0, 5)).toEqual([])
    expect(rows.find((r) => r.principal === 101_000)?.premium).toBe(455)
    expect(rows.find((r) => r.principal === 1_339_000)?.premium).toBe(6_026)
  })
})
