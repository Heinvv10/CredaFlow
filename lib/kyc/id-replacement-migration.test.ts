/**
 * Static proof for migration 20261014130000_replacement_id_pending_not_verified.
 * What the rule does when it runs is proven against Postgres by
 * id-upload-projection.integration.test.ts and face-match-v3-parity.integration.test.ts.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "@/lib/db-baseline.test-helpers"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const read = (dir: string) => fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")
const MIGRATION = "20261014130000_replacement_id_pending_not_verified"

function functionIn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length)
}

const RULE = /\n\s*-- BEGIN replacement-ID rule[\s\S]*?-- END replacement-ID rule\n\s*;\n\$function\$;$/

describe(`migration ${MIGRATION}`, () => {
  const v3 = functionIn(read("20261011080000_face_match_v3_evidence"), "subject_has_composite_kyc")
  const current = baselineFunctionSql("subject_has_composite_kyc")

  it("is the newest definition of subject_has_composite_kyc", () => {
    expect(current).toBe(functionIn(read(MIGRATION), "subject_has_composite_kyc"))
  })

  it("is the v3 body plus one delimited conjunct, nothing else", () => {
    expect(RULE.test(current)).toBe(true)
    // Strip the delimited rule and the closing group it re-opens: what is left
    // is the v3 body, character for character.
    const withoutRule = current.replace(RULE, "\n;\n$function$;")
    expect(withoutRule.replace(/\n\s*\)\n;\n\$function\$;$/, "\n    );\n$function$;")).toBe(v3)
  })

  it("applies the rule through the helper, scoped to the client", () => {
    expect(current).toContain(
      `AND NOT "subject_has_pending_id_replacement"(p_tenant_id, p_client_id)`,
    )
  })

  it("selects the newest non-refused ID copy the way the TypeScript does", () => {
    // This migration's own body. 20261015130000 redefines the helper (any later
    // copy, identical re-upload exempt); id-identical-reupload-migration.test.ts
    // pins that and checks it keeps this ordering.
    const helper = functionIn(read(MIGRATION), "subject_has_pending_id_replacement")
    expect(helper).toContain(`candidate."verificationRejectedAt" IS NULL`)
    expect(helper).toContain(`candidate."verificationRejectedById" IS NULL`)
    expect(helper).toContain(`ORDER BY candidate."createdAt" DESC, candidate."id" COLLATE "C" DESC`)
    expect(helper).toContain(`newest."verified" = false`)
    expect(helper).toContain(`verified_copy."verified" = true`)
  })

  it("demotes already-VERIFIED clients with an audit row, not silently", () => {
    const sql = read(MIGRATION)
    expect(sql).toContain(`'kyc-replacement-id-reset-' || before."id"`)
    expect(sql).toContain(`'reason', 'replacement_id_pending_review'`)
  })
})
