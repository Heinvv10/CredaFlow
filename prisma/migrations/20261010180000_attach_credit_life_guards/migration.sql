-- Attach the bundled credit-life guards.
--
-- The baseline carries the bundled credit-life functions
-- (guardBundledCreditLifeAgreement, guardCreditLifeProductIdentity,
-- lockBundledCreditLifeDependencies, assertBundledCreditLifeDependencies,
-- assertDisbursedCreditLifeCommitInvariant) but none of the 15 triggers that
-- call them. This migration attaches them, scopes
-- assertDisbursedCreditLifeCoverage to applications that reached approval,
-- requires positive credit-life product terms, and indexes the two
-- agreement-document columns the guards look loans up by.
--
-- The six *_credit_life_commit_invariant triggers are DEFERRABLE INITIALLY
-- DEFERRED: the disbursement writes the Loan, then the DISBURSED application,
-- then the bundled policy, and only the final state of the transaction can be
-- judged. A later migration that runs ALTER TABLE on one of these tables in a
-- transaction that has already queued deferred events for it will fail.

CREATE TRIGGER "InsurancePolicy_guard_bundled_credit_life_agreement" BEFORE INSERT OR UPDATE OF "tenantId", "clientId", "type", "policySource", "linkedLoanId", "productId", "premiumAmount", "sumAssured", "startDate", "renewalDate" OR DELETE ON "InsurancePolicy" FOR EACH ROW EXECUTE FUNCTION "guardBundledCreditLifeAgreement"();

CREATE TRIGGER "InsuranceProduct_guard_credit_life_identity" BEFORE UPDATE OF "id", "tenantId", "type" ON "InsuranceProduct" FOR EACH ROW EXECUTE FUNCTION "guardCreditLifeProductIdentity"();

CREATE TRIGGER "Loan_lock_bundled_credit_life_dependencies" BEFORE UPDATE OF "id", "tenantId", "clientId", "applicationId", "agreementDocId", "principal", "startDate", "maturityDate" OR DELETE ON "Loan" FOR EACH ROW EXECUTE FUNCTION "lockBundledCreditLifeDependencies"();

CREATE TRIGGER "Loan_assert_bundled_credit_life_dependencies" AFTER UPDATE OF "id", "tenantId", "clientId", "applicationId", "agreementDocId", "principal", "startDate", "maturityDate" OR DELETE ON "Loan" FOR EACH ROW EXECUTE FUNCTION "assertBundledCreditLifeDependencies"();

CREATE TRIGGER "LoanApplication_lock_bundled_credit_life_dependencies" BEFORE UPDATE OF "id", "tenantId", "clientId", "agreementDocumentId", "agreementDocumentSha256", "agreementSignedAt", "agreementSignedMethod", "agreementSignedByIp", "agreementSignedByUserId", "agreementSignatureData" OR DELETE ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "lockBundledCreditLifeDependencies"();

CREATE TRIGGER "LoanApplication_assert_bundled_credit_life_dependencies" AFTER UPDATE OF "id", "tenantId", "clientId", "agreementDocumentId", "agreementDocumentSha256", "agreementSignedAt", "agreementSignedMethod", "agreementSignedByIp", "agreementSignedByUserId", "agreementSignatureData" OR DELETE ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "assertBundledCreditLifeDependencies"();

CREATE TRIGGER "ClientDocument_lock_bundled_credit_life_dependencies" BEFORE UPDATE OF "id", "tenantId", "clientId", "docType", "fileName", "fileSize", "mimeType", "verified", "verifiedAt", "deletedAt", "storagePath", "contentSha256", "signatureState", "signedAt" OR DELETE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "lockBundledCreditLifeDependencies"();

CREATE TRIGGER "ClientDocument_assert_bundled_credit_life_dependencies" AFTER UPDATE OF "id", "tenantId", "clientId", "docType", "fileName", "fileSize", "mimeType", "verified", "verifiedAt", "deletedAt", "storagePath", "contentSha256", "signatureState", "signedAt" OR DELETE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "assertBundledCreditLifeDependencies"();

CREATE TRIGGER "ComplianceRecord_assert_bundled_credit_life_dependencies" AFTER INSERT OR UPDATE OF "tenantId", "type", "referenceId", "status", "completedAt", "data" OR DELETE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION "assertBundledCreditLifeDependencies"();

CREATE CONSTRAINT TRIGGER "Loan_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "Loan" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

CREATE CONSTRAINT TRIGGER "LoanApplication_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "LoanApplication" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

CREATE CONSTRAINT TRIGGER "ClientDocument_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "ClientDocument" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

CREATE CONSTRAINT TRIGGER "ComplianceRecord_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "ComplianceRecord" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

CREATE CONSTRAINT TRIGGER "InsurancePolicy_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "InsurancePolicy" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

CREATE CONSTRAINT TRIGGER "InsuranceProduct_credit_life_commit_invariant" AFTER INSERT OR UPDATE OR DELETE ON "InsuranceProduct" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "assertDisbursedCreditLifeCommitInvariant"();

-- The commit invariant judged every Loan, including one booked on an
-- application that never reached approval (the demo seed and test fixtures
-- book these). Such an application has no signed agreement and so no
-- credit-life election to enforce. Same body as in
-- 20261009150000_remove_outage_disbursement_exception plus that one early
-- return; APPROVED, DECLINED and CANCELLED stay in scope, so a loan on any of
-- them is still refused at commit.
CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCoverage"(target_application_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_status "AppStatus";
  application_disbursed_at TIMESTAMP(3);
  application_tenant_id TEXT;
  application_client_id TEXT;
  loan_id TEXT;
  loan_tenant_id TEXT;
  loan_client_id TEXT;
  loan_principal INTEGER;
  loan_start_date TIMESTAMP(3);
  loan_maturity_date TIMESTAMP(3);
  elected_credit_life BOOLEAN;
  bundled_policy_count BIGINT;
  valid_bundled_policy_count BIGINT;
BEGIN
  IF target_application_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    application."status",
    application."disbursedAt",
    application."tenantId",
    application."clientId",
    loan."id",
    loan."tenantId",
    loan."clientId",
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    application_status,
    application_disbursed_at,
    application_tenant_id,
    application_client_id,
    loan_id,
    loan_tenant_id,
    loan_client_id,
    loan_principal,
    loan_start_date,
    loan_maturity_date
  FROM "LoanApplication" AS application
  LEFT JOIN "Loan" AS loan
    ON loan."applicationId" = application."id"
  WHERE application."id" = target_application_id
  FOR KEY SHARE OF application;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- An application with no loan and no disbursement is outside this invariant.
  IF loan_id IS NULL
     AND application_status <> 'DISBURSED'::"AppStatus" THEN
    RETURN;
  END IF;

  -- A loan on an application that never reached approval carries no signed
  -- election; seed and fixtures book these. APPROVED stays in scope.
  IF application_status IN ('DRAFT'::"AppStatus", 'SUBMITTED'::"AppStatus", 'UNDER_REVIEW'::"AppStatus") THEN
    RETURN;
  END IF;

  -- A Loan row represents the money path. It and the application transition
  -- must become visible together at commit, regardless of writer version.
  IF loan_id IS NULL
     OR application_status <> 'DISBURSED'::"AppStatus"
     OR application_disbursed_at IS NULL
     OR loan_tenant_id IS DISTINCT FROM application_tenant_id
     OR loan_client_id IS DISTINCT FROM application_client_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan creation and application disbursement must commit together with matching tenant and client evidence';
  END IF;

  elected_credit_life := "resolveCreditLifeElectionForLoan"(
    application_tenant_id,
    application_client_id,
    loan_id
  );

  SELECT COUNT(*)
  INTO bundled_policy_count
  FROM "InsurancePolicy" AS policy
  WHERE policy."linkedLoanId" = loan_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource";

  SELECT COUNT(*)
  INTO valid_bundled_policy_count
  FROM "InsurancePolicy" AS policy
  JOIN "InsuranceProduct" AS product
    ON product."id" = policy."productId"
   AND product."tenantId" = policy."tenantId"
   AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
  WHERE policy."linkedLoanId" = loan_id
    AND policy."tenantId" = application_tenant_id
    AND policy."clientId" = application_client_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
    AND policy."premiumAmount" > 0
    AND policy."sumAssured" > 0
    AND policy."renewalDate" > policy."startDate"
    AND policy."sumAssured" = loan_principal::NUMERIC / 100
    AND policy."premiumAmount" = ROUND((loan_principal::NUMERIC / 100) * 0.0045, 2)
    AND policy."startDate" = loan_start_date
    AND policy."renewalDate" = loan_maturity_date;

  IF elected_credit_life THEN
    IF bundled_policy_count <> 1 OR valid_bundled_policy_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Disbursed loan with elected credit life requires exactly one valid bundled policy';
    END IF;
    PERFORM "assertBundledCreditLifeAgreement"(
      application_tenant_id,
      application_client_id,
      loan_id
    );
  ELSIF bundled_policy_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Disbursed loan without a credit-life election cannot have a bundled policy';
  END IF;
END;
$function$;

-- A CREDIT_LIFE product must carry a premium and a sum assured above zero:
-- the bundled-policy guard refuses a sale against any other, and the
-- credit-life offer guard's no-offer check counts every active one. Other
-- product types are unaffected (rated products ignore these columns).
-- Validated: a database holding a credit-life product without positive terms
-- fails this migration; fix or delete that product first.
ALTER TABLE "InsuranceProduct" ADD CONSTRAINT "InsuranceProduct_credit_life_terms_positive" CHECK ("type" <> 'CREDIT_LIFE'::"InsurancePolicyType" OR ("premiumAmount" > 0 AND "sumAssured" > 0));

-- The commit invariant and the dependency guards find loans by agreement
-- document on every ClientDocument write.
-- CreateIndex
CREATE INDEX "Loan_agreementDocId_idx" ON "Loan"("agreementDocId");

-- CreateIndex
CREATE INDEX "LoanApplication_agreementDocumentId_idx" ON "LoanApplication"("agreementDocumentId");
