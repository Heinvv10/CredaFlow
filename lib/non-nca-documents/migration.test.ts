import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261030090000_non_nca_documents. The rules run against
// Postgres in RUN_DB_IT (gate.integration.test.ts, flow.integration.test.ts); what is
// pinned here is the part no test of behaviour can show: that the South African
// functions the migration rewrites differ from their previous definition ONLY by the
// KEY_FACTS step-aside.
const MIGRATION = "20261030090000_non_nca_documents"
// Comments are dropped first: flattened, a `--` comment would swallow the code after it.
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim()
const before = (name: string) => flat(baselineFunctionSql(name, { beforeMigration: MIGRATION }))
const now = (name: string) => flat(baselineFunctionSql(name))

describe("the PASQ functions the migration rewrites keep their South African behaviour", () => {
  it.each([
    "guardLoanApplicationCreditLifeOffer", "lockLoanApplicationPasqDocument", "guardLoanApplicationPasqApproval", "guardLoanApplicationProviderCountersign",
  ])("%s differs from its previous definition only by one OR on its NON_NCA early return", (name) => {
    const old = `IF NEW."ncaRegime" = 'NON_NCA' THEN`
    expect(before(name).split(old)).toHaveLength(2)
    expect(now(name)).toBe(before(name).replace(old, `IF NEW."ncaRegime" = 'NON_NCA' OR NEW."disclosureRegime" = 'KEY_FACTS' THEN`))
  })

  it("assertDisbursedCreditLifeCoverage differs only by reading disclosureRegime and returning for KEY_FACTS after its commit-together rule", () => {
    const b = now("assertDisbursedCreditLifeCoverage")
    const added = [
      ` application_disclosure "DisclosureRegime";`,
      ` application."disclosureRegime",`,
      ` application_disclosure,`,
      ` IF application_disclosure = 'KEY_FACTS' THEN RETURN; END IF;`,
    ]
    let stripped = b
    for (const part of added) {
      expect(stripped.split(part), part).toHaveLength(2)
      stripped = stripped.replace(part, "")
    }
    // Its previous definition is the live one (a later migration rewrote the baseline's inside a DO block, which the
    // migration reader cannot follow), kept as pg_get_functiondef printed it from a database migrated to the commit before this one.
    const previous = flat(readFileSync("lib/non-nca-documents/__fixtures__/assertDisbursedCreditLifeCoverage.before.sql", "utf8").trim().replace(/;$/, "")) + ";"
    expect(stripped).toBe(previous)
    // The commit-together rule still runs first, for every regime.
    expect(b.indexOf("must commit together")).toBeLessThan(b.indexOf("application_disclosure = 'KEY_FACTS'"))
  })

  it("the approved-status CHECK keeps its previous expression whole as the first branch", () => {
    const check = flat(baselineConstraintSql("LoanApplication_approved_status_requires_pasq"))
    expect(check).toMatch(/^ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_status_requires_pasq" CHECK \(\(\(\(\(\(\(status\)::text <> ALL/)
    expect(check).toContain(`OR (("disclosureRegime" = 'KEY_FACTS'::"DisclosureRegime") AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL)`)
    // A key-facts branch needs an approver and no PASQ: nothing else.
    expect(check).toContain(`AND ("pasqVersion" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) IS TRUE) NOT VALID`)
  })
})

describe("the new objects", () => {
  it("every new function pins search_path to pg_catalog", () => {
    for (const name of [
      "setLoanApplicationDisclosureRegime", "guardLoanApplicationDisclosureRegime", "loanApplicationTermsSha256", "loanDocumentProblem",
      "guardLoanApplicationKeyFactsDocuments", "guardLoanDocumentIssuance",
    ]) expect(now(name), name).toContain("SET search_path = pg_catalog, pg_temp")
  })

  it("the regime is stamped before any other insert trigger reads it, and is fixed on update", () => {
    expect(baselineTriggerSql("LoanApplication_a00_set_disclosure_regime")).toMatch(/BEFORE INSERT ON "LoanApplication"/)
    expect(baselineTriggerSql("LoanApplication_guard_disclosure_regime")).toMatch(/BEFORE UPDATE OF "disclosureRegime"/)
    // Triggers fire in name order: this one sorts before every other LoanApplication insert trigger.
    const others = ["LoanApplication_a0_guard_open_check_flags", "LoanApplication_a_lock_pasq_document_on_insert", "LoanApplication_h_lock_credit_life_offer_on_insert", "LoanApplication_require_pasq_on_insert"]
    for (const other of others) expect("LoanApplication_a00_set_disclosure_regime" < other, other).toBe(true)
  })

  it("the gate fires on the signature and on DISBURSED, for KEY_FACTS rows only, and reads both documents", () => {
    expect(baselineTriggerSql("LoanApplication_z_guard_key_facts_documents")).toMatch(/BEFORE UPDATE OF "status", "agreementSignedAt" ON "LoanApplication" FOR EACH ROW WHEN \(NEW\."disclosureRegime" = 'KEY_FACTS'\)/)
    const gate = now("guardLoanApplicationKeyFactsDocuments")
    for (const part of [`'KEY_FACTS_STATEMENT'`, `'LOAN_AGREEMENT'`, "cannot be ' || CASE WHEN signing THEN 'signed' ELSE 'disbursed' END", "has not been acknowledged", "approved terms changed", "not the issued loan agreement"]) {
      expect(gate, part).toContain(part)
    }
    const problem = now("loanDocumentProblem")
    expect(problem).toContain(`encode(sha256(convert_to(v."bodyHtml", 'UTF8')), 'hex') <> i."templateContentSha256"`)
    expect(problem).toContain(`t."currentVersionId" IS DISTINCT FROM v."id"`)
  })

  it("an issuance is immutable but for supersession and one acknowledgement, and its SAMPLE flag is derived", () => {
    expect(baselineTriggerSql("LoanDocumentIssuance_guard")).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON "LoanDocumentIssuance"/)
    const guard = now("guardLoanDocumentIssuance")
    expect(guard).toContain("cannot be deleted")
    expect(guard).toContain("An issued loan document is immutable")
    expect(guard).toContain(`NEW."sample" := coalesce(demo, false)`)
  })
})
