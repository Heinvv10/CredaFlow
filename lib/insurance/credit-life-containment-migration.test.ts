import { describe, expect, it } from "vitest"
import {
  baselineFunctionSql,
  baselineIndexSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"

// The bundled credit-life functions are in the baseline, but most of the
// triggers that called them were deliberately retired (no credit-life product
// can be sold yet) and are absent from the final schema. These tests pin the
// function bodies kept for reinstatement, plus the indexes and the one
// ComplianceRecord trigger that are still live.
const guardAgreement = baselineFunctionSql("guardBundledCreditLifeAgreement")
const policyTerms = baselineFunctionSql("assertBundledCreditLifePolicyTerms")
const productIdentity = baselineFunctionSql("guardCreditLifeProductIdentity")
const policiesForLoan = baselineFunctionSql("assertBundledCreditLifePoliciesForLoan")
const resolveElection = baselineFunctionSql("resolveCreditLifeElectionForLoan")
const lockLoan = baselineFunctionSql("lockBundledCreditLifeLoan")
const lockDependencies = baselineFunctionSql("lockBundledCreditLifeDependencies")
const disbursedCoverage = baselineFunctionSql("assertDisbursedCreditLifeCoverage")

describe("bundled credit-life database containment", () => {
  it("guardBundledCreditLifeAgreement scopes itself to bundled credit-life policies", () => {
    expect(guardAgreement).toContain(`NEW."type" <> 'CREDIT_LIFE'::"InsurancePolicyType"`)
    expect(guardAgreement).toContain(`NEW."policySource" <> 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"`)
  })

  it("locks the exact product row and freezes identity only after a bundled policy binds", () => {
    expect(policyTerms).toMatch(
      /FROM "InsuranceProduct" AS product[\s\S]*product\."id" = policy_product_id[\s\S]*product\."tenantId" = policy_tenant_id[\s\S]*FOR SHARE;[\s\S]*PERFORM "lockBundledCreditLifeLoan"/,
    )
    expect(productIdentity).toMatch(/EXISTS \([\s\S]*FROM "InsurancePolicy" AS policy[\s\S]*policy\."productId" = OLD\."id"/)
    expect(productIdentity).toContain("Credit-life insurance product identity and type are immutable")
  })

  it("separates new-sale product configuration from frozen historical policy terms", () => {
    expect(policyTerms).toContain("require_current_sale_config boolean")
    expect(policyTerms).toMatch(/IF require_current_sale_config[\s\S]*product_active IS DISTINCT FROM true/)
    expect(policiesForLoan).toMatch(/policy_row\."renewalDate",\s*false/)
    expect(guardAgreement).toMatch(/NEW\."renewalDate",\s*TG_OP = 'INSERT'/)
  })

  it("binds positive bundled policy money and dates to immutable loan terms", () => {
    expect(policyTerms).toContain("policy_premium_amount <= 0")
    expect(policyTerms).toContain("policy_sum_assured <= 0")
    expect(policyTerms).toContain("policy_renewal_date <= policy_start_date")
    expect(policyTerms).toContain("expected_sum_assured := loan_principal::NUMERIC / 100")
    expect(policyTerms).toContain("expected_premium_amount := ROUND(expected_sum_assured * 0.0045, 2)")
    expect(policyTerms).toContain("policy_start_date IS DISTINCT FROM loan_start_date")
    expect(policyTerms).toContain("policy_renewal_date IS DISTINCT FROM loan_maturity_date")
  })

  it("requires an exact completed agreement artifact with an explicit boolean election", () => {
    expect(baselineIndexSql("ComplianceRecord_exact_completed_agreement_artifact_key")).toMatch(
      /^CREATE UNIQUE INDEX "ComplianceRecord_exact_completed_agreement_artifact_key" ON "ComplianceRecord"/,
    )
    expect(resolveElection).toMatch(/application\."agreementDocumentId"/)
    expect(resolveElection).toMatch(/application\."agreementDocumentSha256"/)
    expect(resolveElection).toMatch(/application\."agreementSignedAt"/)
    expect(resolveElection).toMatch(/loan\."agreementDocId"/)
    expect(resolveElection).toContain(`artifact."data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'`)
    expect(resolveElection).toContain(`artifact."data" ->> 'lifecycle' = 'COMPLETED'`)
    expect(resolveElection).toContain(`JSONB_TYPEOF(matching_artifact."data" -> 'creditLifeAutoBundleEligible') = 'boolean'`)
    expect(resolveElection).toContain(`(matching_artifact."data" ->> 'creditLifeAutoBundleEligible')::BOOLEAN`)
    expect(resolveElection).toContain("matching_artifact_count <> 1")
    expect(resolveElection).toContain("RETURN matching_artifact_election")
    expect(resolveElection).toMatch(/SELECT artifact\."data"[\s\S]*?ORDER BY artifact\."id"[\s\S]*?FOR SHARE/)
  })

  it("requires the exact document to carry signed, verified, stored hash evidence", () => {
    expect(resolveElection).toMatch(/JOIN "ClientDocument" AS document/)
    expect(resolveElection).toMatch(/document\."verifiedAt"/)
    expect(resolveElection).toMatch(/document\."signatureState"/)
    expect(resolveElection).toMatch(/document\."signedAt"/)
    expect(resolveElection).toMatch(/document_sha256 IS DISTINCT FROM agreement_document_sha256/)
    expect(resolveElection).toMatch(/document_doc_type IS DISTINCT FROM 'CREDIT_AGREEMENT'/)
    expect(resolveElection).toMatch(/document_mime_type IS DISTINCT FROM 'application\/pdf'/)
    expect(resolveElection).toMatch(/document_verified_at IS DISTINCT FROM document_signed_at/)
    expect(resolveElection).toMatch(/document_deleted_at IS NOT NULL/)
    expect(resolveElection).toMatch(/artifact\."data" ->> 'storagePath' = document_storage_path/)
    expect(resolveElection).toMatch(/artifact\."data" ->> 'fileSize'/)
  })

  it("binds loan, application, client, and artifact to the same tenant", () => {
    expect(resolveElection).toMatch(/application\."tenantId" = loan\."tenantId"/)
    expect(resolveElection).toMatch(/application\."clientId" = loan\."clientId"/)
    expect(resolveElection).toMatch(/loan\."tenantId" = policy_tenant_id/)
    expect(resolveElection).toMatch(/loan\."clientId" = policy_client_id/)
    expect(resolveElection).toMatch(/artifact\."tenantId" = policy_tenant_id/)
  })

  it("serializes and revalidates every reverse-side evidence mutation", () => {
    expect(lockLoan).toContain("pg_advisory_xact_lock")
    expect(lockDependencies).toContain("Bundled credit-life signed agreement evidence is immutable")
    expect(guardAgreement).toContain("Bundled credit-life agreement binding is immutable")
  })

  it("makes the exact completed agreement artifact immutable before a policy exists", () => {
    expect(lockDependencies).toContain("Completed credit-agreement artifacts are immutable")
    expect(lockDependencies).toMatch(
      /TG_OP = 'DELETE'[\s\S]*OLD\."status" = 'COMPLETED'::"ComplianceStatus"[\s\S]*OLD\."completedAt" IS NOT NULL[\s\S]*OLD\."data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'/,
    )
    expect(lockDependencies).toMatch(
      /TG_OP = 'UPDATE'[\s\S]*OLD\."status" = 'COMPLETED'::"ComplianceStatus"[\s\S]*Completed credit-agreement artifacts are immutable/,
    )
    const trigger = baselineTriggerSql("ComplianceRecord_lock_bundled_credit_life_dependencies")
    expect(trigger).toMatch(/ BEFORE [^;]*ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION "lockBundledCreditLifeDependencies"\(\)/)
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      expect(trigger).toMatch(new RegExp(`BEFORE [A-Z ]*\\b${event}\\b[A-Z ]* ON "ComplianceRecord"`))
    }
  })

  it("enforces election-to-policy cardinality", () => {
    expect(baselineIndexSql("InsurancePolicy_one_bundled_credit_life_per_loan")).toMatch(
      /^CREATE UNIQUE INDEX "InsurancePolicy_one_bundled_credit_life_per_loan" ON "InsurancePolicy"/,
    )
    expect(disbursedCoverage).toContain("Disbursed loan with elected credit life requires exactly one valid bundled policy")
    expect(disbursedCoverage).toContain("Loan creation and application disbursement must commit together")
  })

  it("refuses hard deletion of a bundled policy", () => {
    expect(guardAgreement).toContain("Bundled credit-life policy records cannot be hard-deleted")
  })
})
