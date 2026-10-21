import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineIndexSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static reads of the slice 5 part C migrations. The rules themselves are
// proved on real PG (lib/valuation-guides/*.integration.test.ts); these pin the
// objects that only a catalog can show, and the shape of the replaced sale guard.

describe("valuation guide migrations", () => {
  it("counts neither an INTERNAL nor a GUIDE valuation as independent for a recovery sale, in all three places", () => {
    const sale = baselineFunctionSql("guardRemarketingSale")
    expect(sale.split(`v."source" NOT IN ('INTERNAL', 'GUIDE')`)).toHaveLength(4)
    expect(sale).not.toContain(`<> 'INTERNAL'`)
  })

  it("leaves the lease purchase rule on assessors and dealers only", () => {
    expect(baselineFunctionSql("purchaseValuationOk")).toContain(`v."source" IN ('ASSESSOR', 'DEALER')`)
  })

  it("refuses TRUNCATE on both guide tables", () => {
    for (const table of ["ValuationGuide", "ValuationGuideRow"]) {
      expect(baselineTriggerSql(`${table}_no_truncate`)).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"`))
    }
  })

  it("checks a superseded guide's successor at commit", () => {
    expect(baselineTriggerSql("ValuationGuide_successor_published")).toMatch(/CONSTRAINT TRIGGER[\s\S]*DEFERRABLE INITIALLY DEFERRED/)
  })

  it("keeps one current guide per name and one live guide per file", () => {
    expect(baselineIndexSql("ValuationGuide_one_current_per_name")).toContain("PUBLISHED")
    expect(baselineIndexSql("ValuationGuide_live_file")).toContain("DRAFT")
    expect(baselineConstraintSql("ValuationGuide_four_eyes")).toContain(`"publishedById" <> "uploadedById"`)
  })
})
