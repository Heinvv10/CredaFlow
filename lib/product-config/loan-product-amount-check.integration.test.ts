/**
 * Behavioural proof for the CHECK LoanProduct_amount_bounds: a product's
 * minAmount (cents) must be positive and maxAmount must not be below it.
 *
 * Run only against a throwaway PostgreSQL database migrated with all migrations:
 *
 *   RUN_LOAN_PRODUCT_AMOUNT_CHECK_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/product-config/loan-product-amount-check.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_LOAN_PRODUCT_AMOUNT_CHECK_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const CONSTRAINT = "LoanProduct_amount_bounds"

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the loan product amount integration test")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): void {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
}

suite("LoanProduct amount bounds CHECK", () => {
  const tenantId = `tenant_product_amount_${token}`
  let seq = 0

  const insertProduct = (id: string, min: number, max: number) => `
    INSERT INTO "LoanProduct" (
      "id", "tenantId", "code", "name", "productType", "minAmount",
      "maxAmount", "minTermDays", "maxTermDays", "interestRatePm",
      "interestModel"
    ) VALUES (
      '${id}', '${tenantId}', 'PA-${token}-${seq++}', 'Product amount check',
      'PERSONAL', ${min}, ${max}, 30, 90, 0.03, 'DAILY_ACCRUAL'
    )`

  function expectRejected(statement: string): void {
    const result = run(statement)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("23514")
    expect(result.output).toContain(CONSTRAINT)
  }

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('${tenantId}', 'product-amount-${token}', 'Product amount test', CURRENT_TIMESTAMP);
    `)
  })

  afterAll(() => {
    sql(`
      DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${tenantId}';
    `)
  })

  afterEach(() => {
    sql(`DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}'`)
  })

  it("rejects an insert with minAmount 0", () => {
    expectRejected(insertProduct(`zero_${token}`, 0, 100_000))
  })

  it("rejects an insert with a negative minAmount", () => {
    expectRejected(insertProduct(`neg_${token}`, -1, 100_000))
  })

  it("rejects an insert with maxAmount below minAmount", () => {
    expectRejected(insertProduct(`inv_${token}`, 100_000, 99_999))
  })

  it("accepts minAmount equal to maxAmount", () => {
    sql(insertProduct(`eq_${token}`, 50_000, 50_000))
  })

  it("rejects updating a valid product to maxAmount below minAmount", () => {
    sql(insertProduct(`upd_${token}`, 100_000, 1_000_000))
    expectRejected(`UPDATE "LoanProduct" SET "maxAmount" = 99999 WHERE "id" = 'upd_${token}'`)
    expect(run(`SELECT "maxAmount" FROM "LoanProduct" WHERE "id" = 'upd_${token}'`).output.trim()).toBe("1000000")
  })

  it("is a validated constraint, so it also covers rows that already existed", () => {
    expect(
      run(`SELECT convalidated FROM pg_constraint WHERE conname = '${CONSTRAINT}'`).output.trim(),
    ).toBe("t")
  })
})
