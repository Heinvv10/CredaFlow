/**
 * Behavioural proof for the credit-check enforcement in migration
 * 20261013120000_credit_checks_v1 (goal §8.5):
 *
 *   - LoanApplication_a0_guard_open_check_flags refuses APPROVED (or a jump to
 *     DISBURSED) while a flag is OPEN
 *   - ApplicationCheckFlag_guard_record refuses deleting a flag or changing a cleared one
 *   - ApplicationCheckFlag_clearance_complete refuses a CLEARED flag without
 *     who/when/a reason of 15+ characters
 *   - once the flag is cleared, the same approval write goes through
 *
 * Run only against a throwaway PostgreSQL database migrated with all migrations:
 *
 *   RUN_CREDIT_CHECKS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/credit-checks/db-enforcement.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

const RUN = process.env.RUN_CREDIT_CHECKS_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const TRIGGER = "LoanApplication_a0_guard_open_check_flags"
const CHECK = "ApplicationCheckFlag_clearance_complete"

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the credit-checks integration test")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

suite("credit-check enforcement in the database", () => {
  const tenantId = `tenant_checks_${token}`
  const clientId = `client_checks_${token}`
  const productId = `product_checks_${token}`
  const userId = `user_checks_${token}`
  const appId = `app_checks_${token}`
  const flagId = `flag_checks_${token}`

  const approve = `UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = '${appId}'`
  /**
   * The approval write with every OTHER user trigger and CHECK on
   * LoanApplication out of the way, inside a transaction that is rolled back
   * (Postgres DDL is transactional). A synthetic row cannot carry the PASQ,
   * credit-life and affordability evidence those guards demand, and their own
   * suites prove them; this isolates the one under test.
   */
  const isolatedApproval = () => `
    BEGIN;
    ${otherTriggers.map((t) => `ALTER TABLE "LoanApplication" DISABLE TRIGGER "${t}";`).join("\n")}
    ${checks.map((c) => `ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c}";`).join("\n")}
    ${approve};
    SELECT status FROM "LoanApplication" WHERE id = '${appId}';
    ROLLBACK;`
  let otherTriggers: string[] = []
  let checks: string[] = []

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${tenantId}', 'checks-${token}', 'Checks test', now());
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "updatedAt")
        VALUES ('${userId}', '${tenantId}', 'officer-${token}@test.invalid', 'x', 'LOAN_ADMIN', now());
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
        VALUES ('${clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Thabo', 'Tester', 'client-${token}@test.invalid', '+27820000000', now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${productId}', '${tenantId}', 'CHK-${token}', 'Checks product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL'),
               ('${productId}_2', '${tenantId}', 'CHK2-${token}', 'Second product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL');
    `)
    otherTriggers = sql(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> '${TRIGGER}'`)
      .split("\n").filter(Boolean)
    checks = sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`)
      .split("\n").filter(Boolean)
    expect(otherTriggers.length).toBeGreaterThan(0)
  })

  beforeEach(() => {
    sql(`
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
        VALUES ('${appId}', '${tenantId}', 'APP-${token}', '${clientId}', '${productId}', 500000, 30, 'UNDER_REVIEW', now());
      INSERT INTO "ApplicationCheckFlag" ("id", "tenantId", "applicationId", "check", "code", "fingerprint", "summary", "evidence", "updatedAt")
        VALUES ('${flagId}', '${tenantId}', '${appId}', 'SALARY_MATCH', 'NO_SALARY_CREDIT', 'fp-${token}', 'No salary credit.', '{}', now());
    `)
  })

  afterEach(() => {
    sql(`
      BEGIN;
      ALTER TABLE "ApplicationCheckFlag" DISABLE TRIGGER "ApplicationCheckFlag_guard_record";
      DELETE FROM "ApplicationCheckFlag" WHERE "tenantId" = '${tenantId}';
      ALTER TABLE "ApplicationCheckFlag" ENABLE TRIGGER "ApplicationCheckFlag_guard_record";
      COMMIT;
      DELETE FROM "LoanApplication" WHERE "tenantId" = '${tenantId}';
    `)
  })

  afterAll(() => {
    sql(`
      DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Client" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "User" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${tenantId}';
    `)
  })

  it("refuses to approve an application with an OPEN flag, naming the trigger's reason", () => {
    const result = run(approve)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("23514")
    expect(result.output).toContain("open credit-check flags")
    expect(sql(`SELECT status FROM "LoanApplication" WHERE id = '${appId}'`)).toBe("UNDER_REVIEW")
  })

  it("still refuses with every other approval guard out of the way", () => {
    const result = run(isolatedApproval())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("open credit-check flags")
  })

  it("refuses CLEARED without a reason, or with one under 15 characters after trimming", () => {
    const clear = (reason: string) =>
      run(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = ${reason} WHERE id = '${flagId}'`)
    for (const reason of ["NULL", "''", `'   ${"x".repeat(14)}   '`]) {
      const result = clear(reason)
      expect(result.ok, reason).toBe(false)
      expect(result.output).toContain(CHECK)
    }
    expect(clear(`'${"x".repeat(15)}'`).ok).toBe(true)
  })

  it("refuses a jump straight to DISBURSED while a flag is OPEN", () => {
    const result = run(`UPDATE "LoanApplication" SET status = 'DISBURSED' WHERE id = '${appId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("open credit-check flags")
  })

  it("refuses deleting a flag, whatever its status", () => {
    const result = run(`DELETE FROM "ApplicationCheckFlag" WHERE id = '${flagId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("ApplicationCheckFlag_no_delete")
    expect(sql(`SELECT count(*) FROM "ApplicationCheckFlag" WHERE id = '${flagId}'`)).toBe("1")
  })

  it("refuses any change to a cleared flag: reopening it, superseding it or rewriting its reason", () => {
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = 'Salary paid in cash; confirmed with the employer.' WHERE id = '${flagId}'`)
    for (const change of [
      `status = 'OPEN', "clearedById" = NULL, "clearedAt" = NULL, "clearReason" = NULL`,
      `status = 'SUPERSEDED', "clearedById" = NULL, "clearedAt" = NULL, "clearReason" = NULL`,
      `"clearReason" = 'A different reason entirely, written later.'`,
    ]) {
      const result = run(`UPDATE "ApplicationCheckFlag" SET ${change} WHERE id = '${flagId}'`)
      expect(result.ok, change).toBe(false)
      expect(result.output).toContain("ApplicationCheckFlag_cleared_immutable")
    }
  })

  it("refuses a flag raised already cleared or superseded: every flag is born OPEN", () => {
    for (const status of ["CLEARED", "SUPERSEDED"]) {
      const result = run(`INSERT INTO "ApplicationCheckFlag" ("id", "tenantId", "applicationId", "check", "code", "fingerprint", "status", "summary", "evidence", "updatedAt", "clearedById", "clearedAt", "clearReason")
        VALUES ('pre_${token}', '${tenantId}', '${appId}', 'RISK_BEHAVIOUR', 'GAMBLING', 'pre-${token}', '${status}', 'x', '{}', now(),
          ${status === "CLEARED" ? `'${userId}', now(), 'Pre-cleared before anyone raised it'` : "NULL, NULL, NULL"})`)
      expect(result.ok, status).toBe(false)
      expect(result.output).toContain("ApplicationCheckFlag_born_open")
    }
  })

  it("refuses changing a flag's identity, or clearing a superseded one without reopening it", () => {
    for (const change of [`fingerprint = 'other'`, `code = 'OTHER'`, `"check" = 'MANUAL_REVIEW'`]) {
      const result = run(`UPDATE "ApplicationCheckFlag" SET ${change} WHERE id = '${flagId}'`)
      expect(result.ok, change).toBe(false)
      expect(result.output).toContain("ApplicationCheckFlag_transition")
    }
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'SUPERSEDED' WHERE id = '${flagId}'`)
    const result = run(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = 'A reason long enough to pass' WHERE id = '${flagId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("ApplicationCheckFlag_transition")
  })

  it("refuses truncating the flags", () => {
    const result = run(`TRUNCATE "ApplicationCheckFlag"`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("ApplicationCheckFlag_no_delete")
  })

  it("refuses a SUPERSEDED flag that carries a clearance", () => {
    const result = run(`UPDATE "ApplicationCheckFlag" SET status = 'SUPERSEDED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = 'A reason long enough to pass' WHERE id = '${flagId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain(CHECK)
  })

  it("refuses CLEARED without who cleared it and when", () => {
    const result = run(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearReason" = 'A reason long enough to pass' WHERE id = '${flagId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain(CHECK)
  })

  it("refuses an OPEN flag that carries a clearance", () => {
    const result = run(`UPDATE "ApplicationCheckFlag" SET "clearedById" = '${userId}' WHERE id = '${flagId}'`)
    expect(result.ok).toBe(false)
    expect(result.output).toContain(CHECK)
  })

  it("approves once the flag is superseded, and once it is cleared", () => {
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'SUPERSEDED' WHERE id = '${flagId}'`)
    expect(sql(isolatedApproval()).split("\n")).toContain("APPROVED")
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'OPEN' WHERE id = '${flagId}'`)
    expect(run(isolatedApproval()).ok).toBe(false)
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = 'Salary paid in cash; confirmed with the employer.' WHERE id = '${flagId}'`)
    expect(sql(isolatedApproval()).split("\n")).toContain("APPROVED")
  })

  it("only counts the application's own flags", () => {
    sql(`UPDATE "ApplicationCheckFlag" SET status = 'CLEARED', "clearedById" = '${userId}', "clearedAt" = now(), "clearReason" = 'Salary paid in cash; confirmed with the employer.' WHERE id = '${flagId}'`)
    sql(`
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
        VALUES ('${appId}_other', '${tenantId}', 'APP-${token}-2', '${clientId}', '${productId}_2', 500000, 60, 'UNDER_REVIEW', now());
      INSERT INTO "ApplicationCheckFlag" ("id", "tenantId", "applicationId", "check", "code", "fingerprint", "summary", "evidence", "updatedAt")
        VALUES ('${flagId}_other', '${tenantId}', '${appId}_other', 'RISK_BEHAVIOUR', 'GAMBLING', 'fp2-${token}', 'Betting.', '{}', now());
    `)
    expect(sql(isolatedApproval()).split("\n")).toContain("APPROVED")
  })
})
