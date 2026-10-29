import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migrations 20261029100000_jurisdiction_guards and
// 20261029110000_jurisdiction_instance_guard; the rules run against Postgres in
// RUN_DB_IT (guards.integration.test.ts, instance-guard.integration.test.ts).
describe("jurisdiction hand-written objects", () => {
  it("ties currency to jurisdiction: ZA is rand only, LS is loti or rand", () => {
    expect(baselineConstraintSql("TenantConfig_jurisdiction_currency").replace(/\s+/g, " ")).toContain(
      `(("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR')))`,
    )
  })

  it("refuses a jurisdiction change on a lender with applications or loans, whatever RLS shows", () => {
    // 20261029110000: also currency, INSERT, DELETE and a tenantId change.
    expect(baselineTriggerSql("TenantConfig_guard_jurisdiction_change")).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig"/,
    )
    const fn = baselineFunctionSql("guardTenantConfigJurisdictionChange").replace(/\s+/g, " ")
    expect(fn).toContain(`SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = subject`)
    expect(fn).toContain(`SELECT 1 FROM public."Loan" WHERE "tenantId" = subject`)
    expect(fn).toContain(`set_config('app.rls_bypass', 'on', true)`)
    expect(fn).toContain("cannot change, and its configuration cannot be deleted")
    expect(fn).toContain("or move the lender to a new instance")
  })

  it("keeps all ACTIVE tenants of an instance on one jurisdiction and currency", () => {
    expect(baselineTriggerSql("Tenant_guard_instance_jurisdiction")).toMatch(/BEFORE INSERT OR UPDATE OF "status" ON "Tenant" FOR EACH ROW WHEN \(NEW\."status" = 'ACTIVE'\)/)
    expect(baselineTriggerSql("TenantConfig_guard_instance_jurisdiction")).toMatch(
      /BEFORE INSERT OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig"/,
    )
    const fn = baselineFunctionSql("guardInstanceJurisdiction").replace(/\s+/g, " ")
    expect(fn).toContain(`t."status" = 'ACTIVE' AND t."id" <> subject_tenant`)
    expect(fn).toContain(`c."jurisdiction"::text <> subject_jurisdiction OR c."currency"::text <> subject_currency`)
    expect(fn).toContain("One instance serves one jurisdiction")
  })
})
