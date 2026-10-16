import { CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS } from "@/lib/insurance/credit-life-election"
import { describe, expect, it } from "vitest"
import {
  baselineConstraintSql,
  baselineFunctionSql,
  baselineTriggerSql,
} from "../db-baseline.test-helpers"

const approvedRequiresPasq = baselineConstraintSql(
  "LoanApplication_approved_status_requires_pasq",
)
const pasqGuard = baselineFunctionSql("guardLoanApplicationPasqApproval")
const tenantBinding = baselineFunctionSql("guardLoanApplicationTenantBinding")
const boundPasqDocument = [
  baselineFunctionSql("guardBoundPasqDocument"),
  baselineTriggerSql("ClientDocument_guard_bound_pasq_delete"),
  baselineTriggerSql("ClientDocument_guard_bound_pasq_update"),
].join("\n")
const creditLifeOffer = baselineFunctionSql("guardLoanApplicationCreditLifeOffer")

describe("approved PASQ database guard migration", () => {
  it("requires complete client-bound PASQ evidence for approved and disbursed rows", () => {
    expect(approvedRequiresPasq).toContain('"LoanApplication_approved_status_requires_pasq"')
    expect(approvedRequiresPasq).toMatch(/ NOT VALID;$/)
    expect(approvedRequiresPasq).toContain(
      `((status)::text <> ALL (ARRAY['APPROVED'::text, 'DISBURSED'::text]))`,
    )
    expect(approvedRequiresPasq).toContain(`("pasqAcknowledgedBy" = "clientId")`)
    expect(approvedRequiresPasq).toContain(
      `("approvedPasqDocumentSha256" = "pasqDocumentSha256")`,
    )
    expect(approvedRequiresPasq).toContain(
      `(("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256")`,
    )
    expect(approvedRequiresPasq).toMatch(/\) IS TRUE\)[\s\S]*NOT VALID;$/)
    expect(approvedRequiresPasq).toContain(
      `(("pasqEvidence" ->> 'tenantId'::text) = "tenantId")`,
    )
    expect(tenantBinding).toContain(
      `CREATE OR REPLACE FUNCTION public."guardLoanApplicationTenantBinding"`,
    )
    expect(tenantBinding).toContain(`client."tenantId" = NEW."tenantId"`)
    expect(tenantBinding).toContain(`product."tenantId" = NEW."tenantId"`)
    // The stored evidence hash is recomputed in the database, and only the
    // current PASQ version can satisfy an approval.
    expect(baselineFunctionSql("pasqEvidenceSha256V3")).toContain(
      `CREATE OR REPLACE FUNCTION public."pasqEvidenceSha256V3"`,
    )
    expect(approvedRequiresPasq).toContain(
      `("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256")`,
    )
    expect(approvedRequiresPasq).toContain(`("pasqVersion" = 'pasq-v3'::text)`)
    expect(baselineConstraintSql("LoanApplication_tenantId_clientId_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "clientId")`,
    )
    expect(baselineConstraintSql("LoanApplication_tenantId_productId_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "productId")`,
    )
  })

  it("validates application-bound PASQ document metadata", () => {
    expect(pasqGuard).toContain(`document."tenantId" = NEW."tenantId"`)
    expect(pasqGuard).toContain(`document."clientId" = NEW."clientId"`)
    expect(pasqGuard).toContain(
      `document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'`,
    )
    expect(pasqGuard).toContain(
      `document."contentSha256" = NEW."pasqDocumentSha256"`,
    )
  })

  it("freezes approved evidence and only permits a complete return-to-review invalidation", () => {
    expect(pasqGuard).toContain(
      `OLD."status"::TEXT = 'APPROVED'`,
    )
    expect(pasqGuard).toContain(
      `NEW."status"::TEXT = 'UNDER_REVIEW'`,
    )
    expect(pasqGuard).toContain(
      "Approved PASQ evidence may only be invalidated by the explicit return-to-review transition",
    )
    expect(pasqGuard).toContain("PASQ evidence is immutable after approval")
    expect(pasqGuard).toContain(
      "Draft applications may not retain PASQ or acknowledgement evidence",
    )
  })

  it("prevents reverse mutation or deletion of the bound statutory PASQ document", () => {
    expect(boundPasqDocument).toContain(
      `CREATE OR REPLACE FUNCTION public."guardBoundPasqDocument"`,
    )
    expect(boundPasqDocument).toContain(
      `application."pasqDocumentId" = OLD."id"`,
    )
    expect(boundPasqDocument).toContain(
      `application."status"::TEXT IN ('APPROVED', 'DISBURSED')`,
    )
    expect(boundPasqDocument).toContain(
      `BEFORE UPDATE ON "ClientDocument"`,
    )
    expect(boundPasqDocument).toContain(
      `BEFORE DELETE ON "ClientDocument"`,
    )
  })

  it("binds the explicit election to an active same-tenant credit-life offer", () => {
    expect(baselineFunctionSql("pasqCreditLifeMatchesApplication")).toContain(
      `CREATE OR REPLACE FUNCTION public."pasqCreditLifeMatchesApplication"`,
    )
    expect(approvedRequiresPasq).toContain(
      `"pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text,`,
    )
    expect(approvedRequiresPasq).toContain(
      `"creditLifeDisclosureSha256"`,
    )
    expect(baselineConstraintSql("LoanApplication_tenantId_creditLifeProductId_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "creditLifeProductId")`,
    )
    expect(baselineConstraintSql("LoanApplication_tenantId_creditLifeInsurerId_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "creditLifeInsurerId")`,
    )
    expect(baselineConstraintSql("LoanApplication_tenantId_approvedById_fkey")).toContain(
      `FOREIGN KEY ("tenantId", "approvedById")`,
    )
    expect(creditLifeOffer).toContain(
      `product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"`,
    )
    expect(creditLifeOffer).toContain(`product."active" = TRUE`)
    expect(creditLifeOffer).toContain(`insurer."active" = TRUE`)
    expect(pasqGuard).toContain(
      `credit-life evidence is immutable after approval`,
    )
    expect(baselineTriggerSql("LoanApplication_guard_pasq_update")).toMatch(
      /"creditLifeDisclosureAcknowledgedAt"[\s\S]*EXECUTE FUNCTION "guardLoanApplicationPasqApproval"/,
    )
    expect(pasqGuard).toMatch(
      /explicit_return_to_review[\s\S]*NEW\."creditLifeElection"[\s\S]*IS NOT DISTINCT FROM OLD\."creditLifeElection"/,
    )
    expect(creditLifeOffer).toMatch(
      /OLD\."status"::TEXT <> 'DISBURSED'[\s\S]*NEW\."status"::TEXT = 'DISBURSED'/,
    )
    expect(pasqGuard).toContain(
      `NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"`,
    )
    expect(pasqGuard).toContain(
      `NEW."approvedById" IS DISTINCT FROM OLD."approvedById"`,
    )
  })

  // Fair Score audit B6 (migration 20261016152000): a no-offer record is
  // refused while a product is active ONLY above the credit-life threshold, and
  // the SQL threshold is the TypeScript one.
  it("accepts a no-offer record at or below the credit-life threshold", () => {
    expect(creditLifeOffer).toContain(
      `IF GREATEST(NEW."appliedAmount", COALESCE(NEW."approvedAmount", 0)) > ${CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS} AND EXISTS (`,
    )
    expect(creditLifeOffer).toContain("cover became available after this application recorded that none was offered")
  })
})
