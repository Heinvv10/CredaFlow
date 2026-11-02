import { describe, expect, it } from "vitest"
import { baselineConstraintSql, baselineFunctionSql, baselineTriggerSql } from "@/lib/db-baseline.test-helpers"

// Static pins on migration 20261107090000_key_facts_offer_arrears_letter. Behaviour: ls-letters and gate.integration.test.ts.
const MIGRATION = "20261107090000_key_facts_offer_arrears_letter"
const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim()
const before = (name: string) => flat(baselineFunctionSql(name, { beforeMigration: MIGRATION }))
const now = (name: string) => flat(baselineFunctionSql(name))

describe("the offer letter and the arrears letter", () => {
  it("the signature gate only gained the offer letter: every earlier statement of it is still there", () => {
    const gate = now("guardLoanApplicationKeyFactsDocuments")
    for (const part of ["has not been acknowledged by the borrower", "must be acknowledged before the loan agreement is signed", "not the issued loan agreement", "approved terms changed"]) {
      expect(before("guardLoanApplicationKeyFactsDocuments")).toContain(part)
      expect(gate).toContain(part)
    }
    expect(gate).toContain("The offer letter has not been accepted by the borrower")
    expect(gate).toContain(`public."loanDocumentProblem"(NEW."id", 'OFFER_LETTER', signing)`)
  })

  it("a kind and its template key still pair one to one, and only the offer and the statement carry an acceptance", () => {
    expect(flat(baselineConstraintSql("LoanDocumentIssuance_kind_template_key"))).toContain(`"kind"::text = 'OFFER_LETTER' AND "templateKey" = 'non_nca_offer_letter'`)
    expect(flat(baselineConstraintSql("LoanDocumentIssuance_acknowledgement_shape"))).toContain(`"kind"::text IN ('KEY_FACTS_STATEMENT', 'OFFER_LETTER')`)
  })

  it("all four keyed templates are guarded, and the arrears letter's file is kept with the others", () => {
    for (const key of ["non_nca_key_facts", "non_nca_loan_agreement", "non_nca_offer_letter", "non_nca_arrears_letter"]) expect(now("guardLoanDocumentTemplate")).toContain(key)
    expect(now("guardLoanDocumentFile")).toContain(`public."LoanArrearsLetter"`)
  })

  it("a claimed statement's file is kept: the claim itself still passes, because the rule reads OLD", () => {
    expect(now("guardLoanDocumentFile")).toContain(`referenced := OLD."issuedForApplicationId" IS NOT NULL`)
    expect(baselineTriggerSql("ClientDocument_guard_loan_document_file_update")).toContain(`"issuedForApplicationId"`)
  })

  it("a letter is refused for anything but a key-facts loan, is never changed, and its SAMPLE flag is derived", () => {
    const guard = now("guardLoanArrearsLetter")
    expect(guard).toContain(`regime IS DISTINCT FROM 'KEY_FACTS'`)
    expect(guard).toContain("IF TG_OP <> 'INSERT' THEN")
    expect(guard).toContain(`NEW."sample" := coalesce(demo, false)`)
    expect(guard).toContain(`public."loanTemplateVersionApproved"(v)`)
    expect(baselineTriggerSql("LoanArrearsLetter_guard")).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON "LoanArrearsLetter"/)
  })

  it("the Section 129 floor reads the regime and fires for that record type only: a ZA notice meets one extra read and passes", () => {
    expect(baselineTriggerSql("ComplianceRecord_guard_section129_key_facts")).toMatch(/BEFORE INSERT OR UPDATE OF "type", "referenceId" ON "ComplianceRecord" FOR EACH ROW WHEN \(NEW\."type"::text = 'SECTION_129_NOTICE'\)/)
    expect(now("guardSection129KeyFacts")).toContain(`a."disclosureRegime" = 'KEY_FACTS'`)
  })

  it("every new function pins search_path", () => {
    for (const name of ["guardLoanArrearsLetter", "guardSection129KeyFacts", "guardLoanDocumentTemplate", "guardLoanApplicationKeyFactsDocuments", "guardLoanDocumentFile"]) {
      expect(now(name), name).toContain("SET search_path = pg_catalog, pg_temp")
    }
  })
})
