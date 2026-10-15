import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineIndexSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static reading of migration 20261015400000_asset_finance_recovery: the rules
// are all there and none was left out of the real-database suites
// (recovery-rules-*.integration.test.ts, RUN_ASSET_FINANCE_RECOVERY_IT). What
// the rules do when they run is proved there, not here.
const DIR = path.join(process.cwd(), "prisma", "migrations", "20261015400000_asset_finance_recovery")
const sql = fs.readFileSync(path.join(DIR, "migration.sql"), "utf8")
const handWritten = sql.slice(sql.indexOf("-- Hand-written rules"))
const TABLES = ["LegalMatter", "LegalMatterStep", "Recovery", "RecoveryCost", "RemarketingSale", "RecoveryVatEvent", "RecoveryRefund"]

describe("migration 20261015400000: slice 4a recovery schema and rules", () => {
  it("is additive: no drop, rename or column removal of anything that existed", () => {
    expect(sql).not.toMatch(/^\s*DROP\s+(TABLE|COLUMN|TYPE)/im)
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+"[A-Za-z]+"\s+(DROP\s+COLUMN|RENAME)/i)
    expect(sql).toContain(`ALTER TYPE "AssetLessorStatus" ADD VALUE 'RECOVERED'`)
    expect(sql).toContain(`ALTER TYPE "AssetLessorStatus" ADD VALUE 'SOLD_IN_REMARKETING'`)
    expect(sql).toContain(`ALTER TYPE "EntityDocumentType" ADD VALUE 'LEGAL_DOCUMENT'`)
  })

  it("creates the seven tenant-scoped tables with composite (tenantId, id) uniqueness", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
      expect(sql).toContain(`CREATE UNIQUE INDEX "${table}_tenantId_id_key" ON "${table}"("tenantId", "id")`)
    }
  })

  it("adds the lender's allow-lists and demand period to TenantConfig, with defaults", () => {
    expect(sql).toMatch(/"recoveryNcaDeductibleCostTypes" "RecoveryCostType"\[\] DEFAULT ARRAY\['TOWING', 'STORAGE', 'VALUATION', 'REPAIRS', 'ADVERTISING', 'AUCTION_COMMISSION', 'SHERIFF', 'INSURANCE'\]/)
    expect(sql).toMatch(/"recoveryNonNcaChargeableCostTypes" "RecoveryCostType"\[\] DEFAULT ARRAY\[[^\]]*'LEGAL_TAXED', 'LEGAL_CONTRACTUAL', 'OTHER'\]/)
    expect(sql).toContain(`"nonNcaDemandPeriodDays" INTEGER NOT NULL DEFAULT 10`)
  })

  it("enables and forces row-level security with the tenant policy on every new table", () => {
    for (const table of TABLES) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`)
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`)
      expect(sql).toContain(`CREATE POLICY "tenant_isolation" ON "${table}" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());`)
    }
  })

  it("guards every new table with a row trigger and a TRUNCATE statement trigger of the same function", () => {
    const guards: Record<string, string> = {
      LegalMatter: "guardLegalMatter", LegalMatterStep: "guardLegalMatterStep", Recovery: "guardRecovery", RecoveryCost: "guardRecoveryCost",
      RemarketingSale: "guardRemarketingSale", RecoveryVatEvent: "guardRecoveryVatEvent", RecoveryRefund: "guardRecoveryRefund",
    }
    for (const [table, fn] of Object.entries(guards)) {
      expect(baselineTriggerSql(`${table}_guard`)).toMatch(new RegExp(`BEFORE INSERT OR UPDATE OR DELETE ON "${table}"[\\s\\S]*FOR EACH ROW EXECUTE FUNCTION public\\."${fn}"\\(\\)`))
      expect(baselineTriggerSql(`${table}_no_truncate`)).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"[\\s\\S]*FOR EACH STATEMENT EXECUTE FUNCTION public\\."${fn}"\\(\\)`))
    }
  })

  it("raises every database rule as a check violation (23514)", () => {
    const raises = handWritten.match(/RAISE EXCEPTION/g) ?? []
    const withCode = handWritten.match(/RAISE EXCEPTION USING ERRCODE = '23514'/g) ?? []
    // the business-day helper's negative-count guard is a programming error, not a rule
    expect(raises.length - withCode.length).toBe(1)
  })

  it("keeps the partial unique indexes: one open matter and recovery per loan, one completed sale per recovery", () => {
    expect(baselineIndexSql("LegalMatter_one_open_per_loan")).toMatch(/\("tenantId", "loanId"\) WHERE "status" = 'OPEN'/)
    expect(baselineIndexSql("Recovery_one_open_per_loan")).toMatch(/\("tenantId", "loanId"\) WHERE "status" NOT IN \('CLOSED', 'WITHDRAWN'\)/)
    expect(baselineIndexSql("RemarketingSale_one_completed_per_recovery")).toMatch(/\("tenantId", "recoveryId"\) WHERE "status" = 'COMPLETED'/)
  })

  it("counts the section 129 wait in SA business days, 10 of them, as the application does", () => {
    expect(baselineFunctionSql("recoveryAddBusinessDays")).toMatch(/"isSaBusinessDate"\(result\)/)
    expect(baselineFunctionSql("legalMatterS129Matured")).toMatch(/"recoveryAddBusinessDays"\(s\."stepDate", 10\) <= on_date/)
    const step = baselineFunctionSql("guardLegalMatterStep")
    expect(step).toMatch(/c\."type" = 'SECTION_129_NOTICE' AND c\."status" = 'COMPLETED'/)
    expect(step).toContain(`'A NON_NCA summons needs a letter of demand first'`)
    expect(step).toContain(`'An attachment order needs a judgment on the matter first'`)
  })

  it("holds the recovery to its status matrix, its write-once columns and the costs it is owed", () => {
    const guard = baselineFunctionSql("guardRecovery")
    expect(guard).toContain(`IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN`)
    expect(guard).toContain(`format('A recovery cannot go from %s to %s', OLD."status", NEW."status")`)
    expect(guard).toContain(`IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN`)
    expect(guard).toContain(`public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10)`)
    expect(guard).toContain(`COALESCE(config."nonNcaDemandPeriodDays", 10)`)
    expect(baselineConstraintSql("Recovery_shortfall_surplus")).toContain(`GREATEST(0, "settlementDueCents" + "chargedCostsCents" - "netProceedsCents")`)
    expect(baselineConstraintSql("Recovery_net_proceeds")).toContain(`"netProceedsCents" = "grossProceedsCents" - "deductedCostsCents"`)
  })

  it("recomputes a sale's belowValuation and forces relatedPartyMatch on an ID match", () => {
    const sale = baselineFunctionSql("guardRemarketingSale")
    expect(sale).toContain(`IF NEW."belowValuation" IS DISTINCT FROM (NEW."priceInclVatCents" < highest) THEN`)
    expect(sale).toContain(`"leasePurchaseValuationMaxAgeDays"`)
    expect(sale).toContain(`NEW."relatedPartyMatch" := true;`)
    expect(sale).toContain(`public."recoveryBuyerRelated"(NEW."tenantId", rec."loanId", NEW."buyerIdentifier")`)
    expect(sale).toContain(`'A sale''s approval is written once'`)
    expect(baselineFunctionSql("recoveryBuyerRelated")).toContain(`"EntityRelationship"`)
    expect(baselineConstraintSql("RemarketingSale_second_approver")).toContain(`"approvedById" IS NOT NULL AND "approvedById" <> "createdById"`)
  })

  it("lets only the allow-listed cost types be deducted from an NCA recovery's proceeds, and taxed legal costs be charged", () => {
    const cost = baselineFunctionSql("guardRecoveryCost")
    expect(cost).toContain(`config.nca_types`)
    expect(cost).toContain(`NEW."type" <> 'LEGAL_TAXED'`)
    expect(cost).toContain(`s."kind" IN ('JUDGMENT', 'SETTLED')`)
    expect(baselineConstraintSql("RecoveryCost_amounts")).toContain(`"grossCents" = "netCents" + "vatCents"`)
  })

  it("claims input tax on a deemed supply by the tax fraction, half-up, and none on a lessor resale", () => {
    expect(baselineConstraintSql("RecoveryVatEvent_input_tax_formula")).toContain(`(2::BIGINT * "deemedSupplyValueCents" * "vatRateTenThousandths" + (10000 + "vatRateTenThousandths")) / (2 * (10000 + "vatRateTenThousandths"))`)
    expect(baselineConstraintSql("RecoveryVatEvent_resale_no_deemed_supply")).toContain(`"deemedSupplyValueCents" = 0 AND "inputTaxClaimCents" = 0`)
  })

  it("names its actors with composite (tenantId, id) foreign keys to User", () => {
    const columns = [
      ["LegalMatter", "createdById"], ["LegalMatterStep", "recordedById"], ["Recovery", "createdById"], ["RecoveryCost", "recordedById"], ["RecoveryCost", "approvedById"],
      ["RemarketingSale", "createdById"], ["RemarketingSale", "approvedById"], ["RecoveryVatEvent", "recordedById"], ["RecoveryRefund", "createdById"],
      ["RecoveryRefund", "approvedById"], ["RecoveryRefund", "bankVerifiedById"], ["RecoveryRefund", "releasedById"],
    ]
    for (const [table, column] of columns) {
      expect(baselineConstraintSql(`${table}_tenantId_${column}_fkey`)).toContain(`FOREIGN KEY ("tenantId", "${column}") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT`)
    }
  })

  it("requires two people for the surplus refund and for closing the surplus", () => {
    expect(baselineConstraintSql("RecoveryRefund_approver_differs")).toContain(`"approvedById" <> "createdById"`)
    expect(baselineFunctionSql("guardRecoveryRefund")).toContain(`'A refund is the whole surplus of a recovery that holds one'`)
    expect(baselineFunctionSql("guardRecovery")).toContain(`'A surplus closes when its refund is released'`)
  })

  it("has the database write the asset's status, and refuses every other route to it", () => {
    expect(baselineTriggerSql("Recovery_sync_asset_status")).toContain(`AFTER INSERT OR UPDATE OF "status" ON "Recovery"`)
    expect(baselineTriggerSql("RemarketingSale_sync_asset_status")).toContain(`AFTER INSERT OR UPDATE OF "status" ON "RemarketingSale"`)
    const status = baselineFunctionSql("guardAssetLessorStatus")
    expect(status).toContain(`'An asset is recovered by its open recovery'`)
    expect(status).toContain(`'A recovered asset is sold in remarketing by a completed sale'`)
    // the lease rules it replaced are still there
    expect(status).toContain(`'An asset is sold to the lessee by a completed purchase'`)
    const deal = baselineFunctionSql("guardAssetDealUnreleasedAsset")
    expect(deal).toContain(`'The asset has been released and cannot be financed again'`)
    expect(deal).toContain(`lessor_status IN ('RECOVERED', 'SOLD_IN_REMARKETING')`)
  })

  it("leaves no rule without a real-database test: every rule message is asserted by a recovery-rules suite", () => {
    const suites = fs.readdirSync(__dirname).filter((f) => /^recovery-rules-.*\.integration\.test\.ts$/.test(f)).map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n")
    // The lease-era rules guardAssetLessorStatus and guardAssetDealUnreleasedAsset restate are covered by the lease and review-round3 suites.
    const restated = [
      "An asset sold to the lessee is not the lessor's any more", "An asset is sold to the lessee by a completed purchase", "The asset has been released and cannot be financed again",
    ]
    const messages = [...handWritten.matchAll(/MESSAGE = '((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'"))
    expect(messages.length).toBeGreaterThan(70)
    const untested = messages.filter((m) => !restated.includes(m) && !suites.includes(m))
    expect(untested).toEqual([])
  })
})
