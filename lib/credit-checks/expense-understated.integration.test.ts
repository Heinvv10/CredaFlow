/**
 * Behavioural proof for migration 20261014190000_credit_check_expense_understated
 * (goal 2026-10-14 §9.5): the new CreditCheck value exists, an OPEN
 * EXPENSE_UNDERSTATED flag blocks approval through
 * LoanApplication_a0_guard_open_check_flags like any other check's, and once
 * cleared the approval goes through.
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/credit-checks/expense-understated.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const TRIGGER = "LoanApplication_a0_guard_open_check_flags"

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the credit-checks integration test")
  const result = spawnSync("psql", ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", value], { encoding: "utf8" })
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

suite("EXPENSE_UNDERSTATED in the database", () => {
  const tenantId = `tenant_expense_${token}`
  const clientId = `client_expense_${token}`
  const productId = `product_expense_${token}`
  const userId = `user_expense_${token}`
  const appId = `app_expense_${token}`
  const flagId = `flag_expense_${token}`
  const approve = `UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = '${appId}'`
  let isolatedApproval = ""

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${tenantId}', 'expense-${token}', 'Expense test', now());
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "updatedAt")
        VALUES ('${userId}', '${tenantId}', 'officer-${token}@test.invalid', 'x', 'LOAN_ADMIN', now());
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "monthlyExpenses", "updatedAt")
        VALUES ('${clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Thabo', 'Tester', 'client-${token}@test.invalid', '+27820000000', 300000, now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${productId}', '${tenantId}', 'EXP-${token}', 'Expense product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL');
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
        VALUES ('${appId}', '${tenantId}', 'APP-${token}', '${clientId}', '${productId}', 500000, 30, 'UNDER_REVIEW', now());
    `)
    // Every other approval guard out of the way, inside a rolled-back
    // transaction (as db-enforcement.integration.test.ts does): a synthetic row
    // cannot carry the evidence those guards demand, and their own suites prove them.
    const others = sql(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> '${TRIGGER}'`).split("\n").filter(Boolean)
    const checks = sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`).split("\n").filter(Boolean)
    isolatedApproval = `BEGIN;
      ${others.map((t) => `ALTER TABLE "LoanApplication" DISABLE TRIGGER "${t}";`).join("\n")}
      ${checks.map((c) => `ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c}";`).join("\n")}
      ${approve};
      SELECT status FROM "LoanApplication" WHERE id = '${appId}';
      ROLLBACK;`
  })

  afterAll(() => {
    sql(`
      BEGIN;
      ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record";
      DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${tenantId}';
      ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record";
      COMMIT;
      DELETE FROM "LoanApplication" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Client" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "User" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${tenantId}';
    `)
  })

  it("has the new CreditCheck value", () => {
    expect(sql(`SELECT 'EXPENSE_UNDERSTATED'::"CreditCheck"`)).toBe("EXPENSE_UNDERSTATED")
  })

  it("refuses approval while an EXPENSE_UNDERSTATED flag is OPEN, then approves once it is cleared", () => {
    sql(`INSERT INTO "ApplicationCheckFlag" ("id", "tenantId", "applicationId", "check", "code", "fingerprint", "summary", "evidence", "updatedAt")
      VALUES ('${flagId}', '${tenantId}', '${appId}', 'EXPENSE_UNDERSTATED', 'LIVING_SPEND_ABOVE_DECLARED', 'fp-${token}', 'Living spend above declared.', '{"categoriserVersion":"categoriser-v1"}', now())`)
    const refused = run(approve)
    expect(refused.ok).toBe(false)
    expect(refused.output).toContain("open credit-check flags")
    const isolated = run(isolatedApproval)
    expect(isolated.ok).toBe(false)
    expect(isolated.output).toContain("open credit-check flags")

    sql(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(),
      "clearReason" = 'Spouse pays the groceries; confirmed with the client.' WHERE id = '${flagId}'`)
    expect(sql(isolatedApproval).split("\n")).toContain("APPROVED")
  })
})
