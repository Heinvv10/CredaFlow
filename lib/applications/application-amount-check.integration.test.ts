/**
 * Behavioural proof for the CHECK LoanApplication_appliedAmount_positive: an
 * application's requested amount (cents) must be greater than zero.
 *
 * Run only against a throwaway PostgreSQL database migrated with all migrations:
 *
 *   RUN_APPLICATION_AMOUNT_CHECK_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/applications/application-amount-check.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_APPLICATION_AMOUNT_CHECK_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const CONSTRAINT = "LoanApplication_appliedAmount_positive"

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the application amount integration test")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): void {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
}

suite("LoanApplication appliedAmount CHECK", () => {
  const tenantId = `tenant_amount_check_${token}`
  const clientId = `client_amount_check_${token}`
  const productId = `product_amount_check_${token}`

  const insertApplication = (id: string, amount: number) => `
    INSERT INTO "LoanApplication" (
      "id", "tenantId", "reference", "clientId", "productId",
      "appliedAmount", "appliedTermDays", "updatedAt"
    ) VALUES (
      '${id}', '${tenantId}', 'APP-${id}', '${clientId}', '${productId}',
      ${amount}, 30, CURRENT_TIMESTAMP
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
      VALUES ('${tenantId}', 'amount-check-${token}', 'Amount check test', CURRENT_TIMESTAMP);

      INSERT INTO "Client" (
        "id", "tenantId", "reference", "idNumber", "firstName", "lastName",
        "email", "phone", "updatedAt"
      ) VALUES (
        '${clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Amount',
        'Check', 'amount-${token}@test.invalid', '+27820000000', CURRENT_TIMESTAMP
      );

      INSERT INTO "LoanProduct" (
        "id", "tenantId", "code", "name", "productType", "minAmount",
        "maxAmount", "minTermDays", "maxTermDays", "interestRatePm",
        "interestModel"
      ) VALUES (
        '${productId}', '${tenantId}', 'AMT-${token}', 'Amount check product',
        'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL'
      );
    `)
  })

  // One open application per client and product: free the slot between cases.
  afterEach(() => {
    sql(`DELETE FROM "LoanApplication" WHERE "tenantId" = '${tenantId}'`)
  })

  it("rejects an insert with appliedAmount 0", () => {
    expectRejected(insertApplication(`zero_${token}`, 0))
  })

  it("rejects an insert with a negative appliedAmount", () => {
    expectRejected(insertApplication(`neg_${token}`, -1))
  })

  it("accepts an insert with appliedAmount 1", () => {
    sql(insertApplication(`one_${token}`, 1))
  })

  it("rejects updating a valid application to appliedAmount 0", () => {
    sql(insertApplication(`upd_${token}`, 500000))
    expectRejected(`UPDATE "LoanApplication" SET "appliedAmount" = 0 WHERE "id" = 'upd_${token}'`)
    expect(run(`SELECT "appliedAmount" FROM "LoanApplication" WHERE "id" = 'upd_${token}'`).output.trim()).toBe("500000")
  })
})
