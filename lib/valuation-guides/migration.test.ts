import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineIndexSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"
import { GUIDE_DAY_REFUSAL, GUIDE_EFFECTIVE_REFUSAL, GUIDE_TIMES_CHECK } from "./db-refusal"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const PATCH = "20261021090200_guide_not_independent"
/** The statutory guards and the sentence each must keep (patched in by PATCH's DO blocks, which the static reader cannot see). */
const STATUTORY: Record<string, string> = {
  guardSurrenderRequest: "An s127 valuation is never a guide value",
  guardRecovery: "A recovery is never valued on a guide value",
}

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

  it("refuses GUIDE in the statutory guards, and no later migration rewrites either guard without it", () => {
    const patch = fs.readFileSync(path.join(MIGRATIONS, PATCH, "migration.sql"), "utf8")
    for (const [fn, sentence] of Object.entries(STATUTORY)) {
      expect(patch).toContain(`pg_get_functiondef('public."${fn}"()'::regprocedure)`)
      expect(patch).toContain(sentence)
      const later = fs.readdirSync(MIGRATIONS).filter((dir) => dir > PATCH && fs.existsSync(path.join(MIGRATIONS, dir, "migration.sql")))
      for (const dir of later) {
        const sql = fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")
        if (new RegExp(`FUNCTION (public\\.)?"${fn}"`).test(sql)) {
          expect(sql, `${dir} rewrites ${fn}: it must keep the GUIDE refusal`).toContain(sentence)
        }
      }
    }
  })

  it("keeps the sentences the store maps to a 409 in the guards that raise them", () => {
    expect(baselineFunctionSql("guardAssetValuationGuide")).toContain(`MESSAGE = '${GUIDE_DAY_REFUSAL}'`)
    expect(baselineFunctionSql("guardValuationGuide")).toContain(`MESSAGE = '${GUIDE_EFFECTIVE_REFUSAL}'`)
    expect(baselineConstraintSql(GUIDE_TIMES_CHECK)).toContain(`"supersededAt" >= "publishedAt"`)
  })
})

