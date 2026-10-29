import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261029100000_jurisdiction_guards; the rules run
// against Postgres in RUN_DB_IT (guards.integration.test.ts).
describe("jurisdiction hand-written objects", () => {
  it("ties currency to jurisdiction: ZA is rand only, LS is loti or rand", () => {
    expect(baselineConstraintSql("TenantConfig_jurisdiction_currency").replace(/\s+/g, " ")).toContain(
      `(("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR')))`,
    )
  })

  it("refuses a jurisdiction change on a lender with applications or loans, whatever RLS shows", () => {
    expect(baselineTriggerSql("TenantConfig_guard_jurisdiction_change")).toMatch(/BEFORE UPDATE OF "jurisdiction" ON "TenantConfig"/)
    const fn = baselineFunctionSql("guardTenantConfigJurisdictionChange").replace(/\s+/g, " ")
    expect(fn).toContain(`SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = NEW."tenantId"`)
    expect(fn).toContain(`SELECT 1 FROM public."Loan" WHERE "tenantId" = NEW."tenantId"`)
    expect(fn).toContain(`set_config('app.rls_bypass', 'on', true)`)
    expect(fn).toContain("cannot change once it has loan applications or loans")
  })
})
