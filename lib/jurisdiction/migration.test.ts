import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migrations 20261029100000_jurisdiction_guards,
// 20261029110000_jurisdiction_instance_guard and 20261029120000_instance_jurisdiction;
// the rules run against Postgres in RUN_DB_IT (instance-guard.integration.test.ts).
const flat = (sql: string) => sql.replace(/\s+/g, " ")

describe("jurisdiction hand-written objects", () => {
  it("ties currency to jurisdiction on the lender and on the instance: ZA is rand only, LS is loti or rand", () => {
    const rule = `(("jurisdiction" = 'ZA' AND "currency" = 'ZAR') OR ("jurisdiction" = 'LS' AND "currency" IN ('LSL', 'ZAR')))`
    expect(flat(baselineConstraintSql("TenantConfig_jurisdiction_currency"))).toContain(rule)
    expect(flat(baselineConstraintSql("InstanceJurisdiction_jurisdiction_currency"))).toContain(rule)
    expect(flat(baselineConstraintSql("InstanceJurisdiction_singleton"))).toContain(`CHECK (("id" = 1))`)
  })

  it("the tenant-against-tenant rule of the previous round is gone (one row replaces it)", () => {
    expect(() => baselineTriggerSql("Tenant_guard_instance_jurisdiction")).toThrow()
    expect(() => baselineTriggerSql("TenantConfig_guard_instance_jurisdiction")).toThrow()
    expect(() => baselineTriggerSql("TenantConfig_guard_jurisdiction_change")).toThrow()
    expect(() => baselineFunctionSql("guardInstanceJurisdiction")).toThrow()
  })

  it("refuses a lender whose config differs from the instance row: on its config, and on becoming ACTIVE or PROVISIONING", () => {
    expect(baselineTriggerSql("TenantConfig_guard_matches_instance")).toMatch(
      /BEFORE INSERT OR UPDATE OF "jurisdiction", "currency", "tenantId" ON "TenantConfig"/,
    )
    expect(baselineTriggerSql("Tenant_guard_matches_instance")).toMatch(
      /BEFORE INSERT OR UPDATE OF "status" ON "Tenant" FOR EACH ROW WHEN \(NEW\."status" IN \('ACTIVE', 'PROVISIONING'\)\)/,
    )
    for (const name of ["guardTenantConfigMatchesInstance", "guardTenantMatchesInstance"]) {
      const fn = flat(baselineFunctionSql(name))
      expect(fn, name).toContain(`pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'))`)
      expect(fn, name).toContain(`FROM public."InstanceJurisdiction" WHERE "id" = 1`)
      expect(fn, name).toContain("One instance serves one jurisdiction")
    }
    // The lock comes first in each.
    for (const name of ["guardTenantConfigMatchesInstance", "guardTenantMatchesInstance", "guardInstanceJurisdictionChange"]) {
      const fn = flat(baselineFunctionSql(name))
      expect(fn.indexOf("pg_advisory_xact_lock"), name).toBeGreaterThan(-1)
      expect(fn.indexOf("pg_advisory_xact_lock"), name).toBeLessThan(fn.indexOf("SELECT") === -1 ? Infinity : fn.indexOf("SELECT"))
    }
  })

  it("the instance row is immutable once any loan application or loan exists, cannot be deleted or truncated, and a change needs every lender to agree", () => {
    expect(baselineTriggerSql("InstanceJurisdiction_guard_change")).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON "InstanceJurisdiction"/)
    expect(baselineTriggerSql("InstanceJurisdiction_guard_truncate")).toMatch(/BEFORE TRUNCATE ON "InstanceJurisdiction" FOR EACH STATEMENT/)
    expect(baselineTriggerSql("InstanceJurisdiction_configs_agree")).toMatch(/AFTER INSERT OR UPDATE ON "InstanceJurisdiction" DEFERRABLE INITIALLY DEFERRED/)
    const change = flat(baselineFunctionSql("guardInstanceJurisdictionChange"))
    expect(change).toContain(`SELECT 1 FROM public."LoanApplication"`)
    expect(change).toContain(`SELECT 1 FROM public."Loan"`)
    expect(change).toContain(`set_config('app.rls_bypass', 'on', true)`)
    expect(change).toContain("cannot change once any loan application or loan exists")
    expect(flat(baselineFunctionSql("checkInstanceConfigsAgree"))).toContain(`c."jurisdiction" <> NEW."jurisdiction" OR c."currency" <> NEW."currency"`)
  })

  it("a lender's configuration cannot be deleted once it has loan applications or loans", () => {
    expect(baselineTriggerSql("TenantConfig_guard_delete_with_loans")).toMatch(/BEFORE DELETE ON "TenantConfig"/)
    const fn = flat(baselineFunctionSql("guardTenantConfigDelete"))
    expect(fn).toContain(`SELECT 1 FROM public."LoanApplication" WHERE "tenantId" = OLD."tenantId"`)
    expect(fn).toContain(`SELECT 1 FROM public."Loan" WHERE "tenantId" = OLD."tenantId"`)
    expect(fn).toContain("retire the lender by setting its status to SUSPENDED")
  })
})
