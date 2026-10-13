import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

describe("asset-finance NCA database enforcement", () => {
  it("requires exactly one borrower on every asset deal", () => {
    expect(baselineConstraintSql("AssetFinanceDeal_borrower_xor")).toMatch(/clientId[\s\S]*entityId[\s\S]*= 1/)
  })

  it("requires an affordable recorded s81 assessment before NCA approval", () => {
    const sql = baselineFunctionSql("guardAssetFinanceNcaApproval")
    expect(sql).toMatch(/ncaRegime[\s\S]*NCA[\s\S]*AssetFinanceAffordabilityAssessment[\s\S]*affordable/)
    expect(baselineTriggerSql("LoanApplication_asset_nca_affordability")).toContain("guardAssetFinanceNcaApproval")
  })

  it("checks NCA asset rates and fees again at the Loan write boundary", () => {
    const sql = baselineFunctionSql("guardAssetFinanceNcaCaps")
    expect(sql).toMatch(/REPO[\s\S]*0\.17[\s\S]*initiationFee[\s\S]*monthlyServiceFee[\s\S]*6000/)
    expect(baselineTriggerSql("Loan_asset_nca_caps")).toContain("guardAssetFinanceNcaCaps")
  })
})
