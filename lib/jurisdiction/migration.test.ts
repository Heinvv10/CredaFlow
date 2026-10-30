import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migrations 20261029101000_jurisdiction_guards,
// 20261029110000_jurisdiction_instance_guard and 20261029120000_instance_jurisdiction;
// the rules run against Postgres in RUN_DB_IT (instance-guard.integration.test.ts).
const MIGRATION = "prisma/migrations/20261029120000_instance_jurisdiction/migration.sql"
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
      expect(fn, name).toContain(`public."lockInstanceJurisdiction"(true)`)
      expect(fn, name).toContain(`FROM public."InstanceJurisdiction" WHERE "id" = 1`)
      expect(fn, name).toContain("One instance serves one jurisdiction")
    }
    // The lock (which also refuses a snapshot isolation level) comes first in each guard, before it reads anything.
    for (const name of ["guardTenantConfigMatchesInstance", "guardTenantMatchesInstance", "guardTenantConfigDelete", "guardInstanceJurisdictionChange"]) {
      const fn = flat(baselineFunctionSql(name))
      const lock = fn.indexOf(`public."lockInstanceJurisdiction"(`)
      expect(lock, name).toBeGreaterThan(-1)
      expect(lock, name).toBeLessThan(fn.indexOf("SELECT") === -1 ? Infinity : fn.indexOf("SELECT"))
      expect(lock, name).toBeLessThan(fn.indexOf("EXISTS") === -1 ? Infinity : fn.indexOf("EXISTS"))
    }
    const lock = flat(baselineFunctionSql("lockInstanceJurisdiction"))
    expect(lock).toContain(`pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'))`)
    expect(lock).toContain(`pg_advisory_xact_lock_shared(hashtext('credaflow.instance_jurisdiction'))`)
    expect(lock).toContain(`current_setting('transaction_isolation') <> 'read committed'`)
  })

  it("the tenant and config guards take the lock shared; the instance change, the config delete and the writer take it exclusive", () => {
    for (const name of ["guardTenantConfigMatchesInstance", "guardTenantMatchesInstance"]) {
      expect(flat(baselineFunctionSql(name)), name).toContain(`public."lockInstanceJurisdiction"(true)`)
    }
    for (const name of ["guardTenantConfigDelete", "guardInstanceJurisdictionChange"]) {
      expect(flat(baselineFunctionSql(name)), name).toContain(`public."lockInstanceJurisdiction"()`)
    }
    expect(readFileSync("lib/jurisdiction/instance-write.ts", "utf8")).toContain("SELECT pg_advisory_xact_lock(hashtext('credaflow.instance_jurisdiction'))")
  })

  it("every jurisdiction guard function pins search_path to pg_catalog first, so a schema cannot shadow an operator or function it calls", () => {
    const names = [
      "lockInstanceJurisdiction", "guardTenantConfigMatchesInstance", "guardTenantMatchesInstance", "guardTenantConfigDelete",
      "guardInstanceJurisdictionChange", "guardInstanceJurisdictionTruncate", "checkInstanceConfigsAgree", "holdInstanceJurisdiction",
    ]
    for (const name of names) {
      expect(flat(baselineFunctionSql(name)), name).toMatch(/SET search_path = pg_catalog, pg_temp AS/)
    }
    // Every function this migration creates is in the list above.
    const created = [...readFileSync(MIGRATION, "utf8").matchAll(/CREATE OR REPLACE FUNCTION public\."(\w+)"/g)].map((m) => m[1])
    expect(created.sort()).toEqual([...names].sort())
    // No unqualified enum cast: pg_catalog does not hold them.
    expect(readFileSync(MIGRATION, "utf8")).not.toMatch(/::"(Jurisdiction|LenderCurrency)"/)
  })

  it("a new config takes the instance's values on INSERT (an upsert inserts first), and an update that would differ is refused", () => {
    const fn = flat(baselineFunctionSql("guardTenantConfigMatchesInstance"))
    expect(fn).toContain(`IF TG_OP = 'INSERT' THEN`)
    expect(fn).toContain(`NEW."jurisdiction" := inst_j::public."Jurisdiction"`)
    expect(fn).toContain(`NEW."currency" := inst_c::public."LenderCurrency"`)
    expect(fn).toContain("this lender would be")
  })

  it("an application or loan INSERT holds the instance lock shared and stamps frozenAt, which the change guard honours and never clears", () => {
    for (const [trigger, table] of [["LoanApplication_hold_instance_jurisdiction", "LoanApplication"], ["Loan_hold_instance_jurisdiction", "Loan"]]) {
      expect(baselineTriggerSql(trigger)).toMatch(new RegExp(`BEFORE INSERT ON "${table}" FOR EACH STATEMENT`))
    }
    const hold = flat(baselineFunctionSql("holdInstanceJurisdiction"))
    expect(hold).toContain(`pg_advisory_xact_lock_shared(hashtext('credaflow.instance_jurisdiction'))`)
    expect(hold).toContain(`SET "frozenAt" = now() WHERE "id" = 1 AND "frozenAt" IS NULL`)
    const change = flat(baselineFunctionSql("guardInstanceJurisdictionChange"))
    expect(change).toContain(`OLD."frozenAt" IS NOT NULL`)
    expect(change).toContain("frozenAt cannot be changed or cleared")
  })

  it("the instance row is immutable once any loan application or loan exists, cannot be deleted or truncated, and a change needs every lender to agree", () => {
    expect(baselineTriggerSql("InstanceJurisdiction_guard_change")).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON "InstanceJurisdiction"/)
    expect(baselineTriggerSql("InstanceJurisdiction_guard_truncate")).toMatch(/BEFORE TRUNCATE ON "InstanceJurisdiction" FOR EACH STATEMENT/)
    expect(baselineTriggerSql("InstanceJurisdiction_configs_agree")).toMatch(/AFTER INSERT OR UPDATE OF "jurisdiction", "currency" ON "InstanceJurisdiction" DEFERRABLE INITIALLY DEFERRED/)
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
