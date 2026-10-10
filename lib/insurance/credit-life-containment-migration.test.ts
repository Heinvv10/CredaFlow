import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineIndexSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"

// The bundled credit-life functions are in the baseline; the 15 triggers that
// call them are attached by 20261010180000_attach_credit_life_guards (the
// ComplianceRecord lock trigger was never detached). These tests pin the
// function bodies, the trigger definitions and the indexes as written. Whether
// the rules hold when they run is the integration suite's job
// (credit-life-containment-migration.integration.test.ts).
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

  it("leaves loans on applications that never reached approval outside the commit invariant", () => {
    expect(disbursedCoverage).toMatch(
      /IF loan_id IS NULL\s+AND application_status <> 'DISBURSED'::"AppStatus" THEN\s+RETURN;\s+END IF;\s+(?:--[^\n]*\n\s*)*IF application_status IN \('DRAFT'::"AppStatus", 'SUBMITTED'::"AppStatus", 'UNDER_REVIEW'::"AppStatus"\) THEN\s+RETURN;\s+END IF;\s+(?:--[^\n]*\n\s*)*IF loan_id IS NULL\s+OR application_status <> 'DISBURSED'::"AppStatus"/,
    )
    for (const status of ["APPROVED", "DECLINED", "CANCELLED", "DISBURSED"]) {
      expect(disbursedCoverage).not.toMatch(new RegExp(`IF application_status IN \\([^)]*'${status}'`))
    }
  })
})

const loanColumns = ["id", "tenantId", "clientId", "applicationId", "agreementDocId", "principal", "startDate", "maturityDate"]
const applicationColumns = [
  "id", "tenantId", "clientId", "agreementDocumentId", "agreementDocumentSha256", "agreementSignedAt",
  "agreementSignedMethod", "agreementSignedByIp", "agreementSignedByUserId", "agreementSignatureData",
]
const documentColumns = [
  "id", "tenantId", "clientId", "docType", "fileName", "fileSize", "mimeType", "verified", "verifiedAt",
  "deletedAt", "storagePath", "contentSha256", "signatureState", "signedAt",
]
const updateOf = (columns: string[]) => `UPDATE OF ${columns.map((c) => `"${c}"`).join(", ")}`

// [trigger, table, timing + events exactly as written, function]
const attached: Array<[string, string, string, string]> = [
  ["InsurancePolicy_guard_bundled_credit_life_agreement", "InsurancePolicy",
    `BEFORE INSERT OR ${updateOf(["tenantId", "clientId", "type", "policySource", "linkedLoanId", "productId", "premiumAmount", "sumAssured", "startDate", "renewalDate"])} OR DELETE`,
    "guardBundledCreditLifeAgreement"],
  ["InsuranceProduct_guard_credit_life_identity", "InsuranceProduct",
    `BEFORE ${updateOf(["id", "tenantId", "type"])}`, "guardCreditLifeProductIdentity"],
  ["Loan_lock_bundled_credit_life_dependencies", "Loan",
    `BEFORE ${updateOf(loanColumns)} OR DELETE`, "lockBundledCreditLifeDependencies"],
  ["Loan_assert_bundled_credit_life_dependencies", "Loan",
    `AFTER ${updateOf(loanColumns)} OR DELETE`, "assertBundledCreditLifeDependencies"],
  ["LoanApplication_lock_bundled_credit_life_dependencies", "LoanApplication",
    `BEFORE ${updateOf(applicationColumns)} OR DELETE`, "lockBundledCreditLifeDependencies"],
  ["LoanApplication_assert_bundled_credit_life_dependencies", "LoanApplication",
    `AFTER ${updateOf(applicationColumns)} OR DELETE`, "assertBundledCreditLifeDependencies"],
  ["ClientDocument_lock_bundled_credit_life_dependencies", "ClientDocument",
    `BEFORE ${updateOf(documentColumns)} OR DELETE`, "lockBundledCreditLifeDependencies"],
  ["ClientDocument_assert_bundled_credit_life_dependencies", "ClientDocument",
    `AFTER ${updateOf(documentColumns)} OR DELETE`, "assertBundledCreditLifeDependencies"],
  ["ComplianceRecord_assert_bundled_credit_life_dependencies", "ComplianceRecord",
    `AFTER INSERT OR ${updateOf(["tenantId", "type", "referenceId", "status", "completedAt", "data"])} OR DELETE`,
    "assertBundledCreditLifeDependencies"],
]
const commitInvariantTables = ["Loan", "LoanApplication", "ClientDocument", "ComplianceRecord", "InsurancePolicy", "InsuranceProduct"]

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim()

describe("bundled credit-life triggers", () => {
  it.each(attached)("%s is attached to %s with its exact events and function", (name, table, events, fn) => {
    expect(oneLine(baselineTriggerSql(name))).toBe(
      `CREATE TRIGGER "${name}" ${events} ON "${table}" FOR EACH ROW EXECUTE FUNCTION "${fn}"();`,
    )
  })

  it.each(commitInvariantTables)("%s carries the deferred commit invariant on every write", (table) => {
    const name = `${table}_credit_life_commit_invariant`
    expect(oneLine(baselineTriggerSql(name))).toBe(
      `CREATE CONSTRAINT TRIGGER "${name}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();`,
    )
  })
})

describe("bundled credit-life migration", () => {
  const migrationSql = fs.readFileSync(
    path.join(__dirname, "..", "..", "prisma", "migrations", "20261010180000_attach_credit_life_guards", "migration.sql"),
    "utf8",
  )

  it("creates exactly the 15 credit-life triggers and no other", () => {
    const created = [...migrationSql.matchAll(/^\s*CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"([^"]+)"/gim)].map((m) => m[1])
    expect(created.sort()).toEqual([
      ...attached.map(([name]) => name),
      ...commitInvariantTables.map((table) => `${table}_credit_life_commit_invariant`),
    ].sort())
  })

  it("requires a positive premium and cover on every credit-life product, validated", () => {
    expect(oneLine(baselineConstraintSql("InsuranceProduct_credit_life_terms_positive"))).toBe(
      `ALTER TABLE "InsuranceProduct" ADD CONSTRAINT "InsuranceProduct_credit_life_terms_positive" CHECK ("type" <> 'CREDIT_LIFE'::"InsurancePolicyType" OR ("premiumAmount" > 0 AND "sumAssured" > 0));`,
    )
  })

  it.each([
    ["LoanApplication_agreementDocumentId_idx", "LoanApplication", "agreementDocumentId"],
    ["Loan_agreementDocId_idx", "Loan", "agreementDocId"],
  ])("indexes %s for the agreement-document lookups", (name, table, column) => {
    expect(oneLine(baselineIndexSql(name))).toBe(`CREATE INDEX "${name}" ON "${table}"("${column}");`)
  })
})
