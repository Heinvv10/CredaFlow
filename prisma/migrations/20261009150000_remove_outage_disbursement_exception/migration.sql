-- Remove the outage disbursement exception. Its per-application allow-list was
-- empty, so validOutageDisbursementException was false for every row and no
-- application could take the exception path. Every guard that consulted it now
-- runs its normal branch unconditionally; nothing else in those guards changes.

-- DropTrigger
DROP TRIGGER "ComplianceRecord_guard_outage_disbursement_exception" ON "ComplianceRecord";
DROP TRIGGER "LoanApplication_guard_outage_exception_binding" ON "LoanApplication";

-- Same expression minus the outage OR-branch; still NOT VALID, as before.
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_approved_status_requires_pasq";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_status_requires_pasq" CHECK (((((status)::text <> ALL (ARRAY['APPROVED'::text, 'DISBURSED'::text])) OR (((status)::text = 'APPROVED'::text) AND ("agreementSignedAt" IS NULL) AND ("agreementCountersignedAt" IS NULL) AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ((("pasqVersion" IS NULL) AND ("pasqGeneratedAt" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqDocumentSha256" IS NULL) AND ("pasqEvidence" IS NULL) AND ("pasqEvidenceSha256" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt") AND ((("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256")))))) OR (("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND ("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt"))) IS TRUE)) NOT VALID;

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

CREATE OR REPLACE FUNCTION public."guardLoanApplicationProviderCountersign"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  expected_provider_signature_sha256 TEXT;
  expected_consumer_signature_sha256 TEXT;
  expected_envelope_sha256 TEXT;
BEGIN
  explicit_return_to_review :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementSignedMethod" IS NULL
    AND NEW."agreementSignedByUserId" IS NULL
    AND NEW."agreementSignatureData" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedById" IS NULL
    AND NEW."agreementCountersignedByName" IS NULL
    AND NEW."agreementCountersignedByEmail" IS NULL
    AND NEW."agreementCountersignatureData" IS NULL
    AND NEW."agreementCountersignatureSha256" IS NULL
    AND NEW."agreementCountersignatureEnvelopeSha256" IS NULL
    AND NEW."agreementCountersignedDocumentSha256" IS NULL;

  IF NEW."agreementCountersignatureData" IS NOT NULL THEN
    expected_provider_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementCountersignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF NEW."agreementSignatureData" IS NOT NULL THEN
    expected_consumer_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementSignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF
    expected_provider_signature_sha256 IS NOT NULL
    AND expected_consumer_signature_sha256 IS NOT NULL
  THEN
    expected_envelope_sha256 := "providerCountersignEnvelopeSha256"(
      NEW."tenantId",
      NEW."id",
      NEW."clientId",
      NEW."agreementDocumentSha256",
      NEW."agreementSignedAt",
      NEW."agreementSignedMethod",
      CASE
        WHEN NEW."agreementSignedMethod" = 'portal' THEN NEW."clientId"
        ELSE NEW."agreementSignedByUserId"
      END,
      expected_consumer_signature_sha256,
      NEW."agreementCountersignedAt",
      NEW."agreementCountersignedById",
      NEW."agreementCountersignedByName",
      NEW."agreementCountersignedByEmail",
      expected_provider_signature_sha256
    );
  END IF;

  IF NEW."status"::TEXT = 'DISBURSED' AND (
    NEW."agreementDocumentSha256" IS NULL
    OR NEW."agreementDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementSignedAt" IS NULL
    OR NEW."agreementSignedMethod" IS NULL
    OR NEW."agreementSignedMethod" NOT IN ('portal', 'branch')
    OR NEW."agreementSignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementSignatureData")) = 0
    OR (
      NEW."agreementSignedMethod" = 'portal'
      AND NEW."agreementSignedByUserId" IS NOT NULL
    )
    OR (
      NEW."agreementSignedMethod" = 'branch'
      AND (
        NEW."agreementSignedByUserId" IS NULL
        OR LENGTH(BTRIM(NEW."agreementSignedByUserId")) = 0
      )
    )
    OR NEW."agreementCountersignedAt" IS NULL
    OR NEW."agreementCountersignedById" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedById")) = 0
    OR NEW."agreementCountersignedByName" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByName")) = 0
    OR NEW."agreementCountersignedByEmail" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByEmail")) = 0
    OR NEW."agreementCountersignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignatureData")) = 0
    OR NEW."agreementCountersignatureSha256"
      IS DISTINCT FROM expected_provider_signature_sha256
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM expected_envelope_sha256
    OR NEW."agreementCountersignedDocumentSha256" IS NULL
    OR NEW."agreementCountersignedDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementCountersignedAt" < NEW."agreementSignedAt"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM NEW."agreementDocumentSha256"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires provider countersign evidence bound to the exact tenant, consumer signature and agreement';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."agreementCountersignedAt" IS NOT NULL AND (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."agreementDocumentId" IS DISTINCT FROM OLD."agreementDocumentId"
    OR NEW."agreementDocumentSha256" IS DISTINCT FROM OLD."agreementDocumentSha256"
    OR NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
    OR NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
    OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
    OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"
    OR NEW."agreementCountersignedAt" IS DISTINCT FROM OLD."agreementCountersignedAt"
    OR NEW."agreementCountersignedById" IS DISTINCT FROM OLD."agreementCountersignedById"
    OR NEW."agreementCountersignedByName" IS DISTINCT FROM OLD."agreementCountersignedByName"
    OR NEW."agreementCountersignedByEmail" IS DISTINCT FROM OLD."agreementCountersignedByEmail"
    OR NEW."agreementCountersignatureData" IS DISTINCT FROM OLD."agreementCountersignatureData"
    OR NEW."agreementCountersignatureSha256" IS DISTINCT FROM OLD."agreementCountersignatureSha256"
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM OLD."agreementCountersignatureEnvelopeSha256"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM OLD."agreementCountersignedDocumentSha256"
  ) AND NOT explicit_return_to_review THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Consumer and provider signature evidence is immutable after provider countersign';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanPasqV3Billing"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."applicationId" IS DISTINCT FROM NEW."applicationId"
    OR OLD."clientId" IS DISTINCT FROM NEW."clientId"
    OR OLD."productId" IS DISTINCT FROM NEW."productId"
    OR OLD."principal" IS DISTINCT FROM NEW."principal"
    OR OLD."totalInterest" IS DISTINCT FROM NEW."totalInterest"
    OR OLD."initiationFee" IS DISTINCT FROM NEW."initiationFee"
    OR OLD."creditLifePremiums" IS DISTINCT FROM NEW."creditLifePremiums"
    OR OLD."totalRepayable" IS DISTINCT FROM NEW."totalRepayable"
    OR OLD."contractualTotalInterest"
      IS DISTINCT FROM NEW."contractualTotalInterest"
    OR OLD."contractualTotalRepayable"
      IS DISTINCT FROM NEW."contractualTotalRepayable"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3Billing"(NEW."id");
  IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."id");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanPasqV3ScheduleDates"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."applicationId" IS DISTINCT FROM NEW."applicationId"
    OR OLD."startDate" IS DISTINCT FROM NEW."startDate"
    OR OLD."maturityDate" IS DISTINCT FROM NEW."maturityDate"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3ScheduleDates"(NEW."id");
  IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."id");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRepaymentSchedulePasqV3Billing"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."loanId");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."loanId" IS DISTINCT FROM NEW."loanId"
    OR OLD."installmentNo" IS DISTINCT FROM NEW."installmentNo"
    OR OLD."principalDue" IS DISTINCT FROM NEW."principalDue"
    OR OLD."interestDue" IS DISTINCT FROM NEW."interestDue"
    OR OLD."creditLifePremiumDue"
      IS DISTINCT FROM NEW."creditLifePremiumDue"
    OR OLD."feesDue" IS DISTINCT FROM NEW."feesDue"
    OR OLD."totalDue" IS DISTINCT FROM NEW."totalDue"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3Billing"(NEW."loanId");
  IF TG_OP = 'UPDATE' AND OLD."loanId" IS DISTINCT FROM NEW."loanId" THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."loanId");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRepaymentSchedulePasqV3Dates"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."loanId");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."loanId" IS DISTINCT FROM NEW."loanId"
    OR OLD."installmentNo" IS DISTINCT FROM NEW."installmentNo"
    OR OLD."dueDate" IS DISTINCT FROM NEW."dueDate"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3ScheduleDates"(NEW."loanId");
  IF TG_OP = 'UPDATE' AND OLD."loanId" IS DISTINCT FROM NEW."loanId" THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."loanId");
  END IF;
  RETURN NEW;
END;
$function$;

-- DropFunction
DROP FUNCTION public."guardLoanApplicationOutageExceptionBinding"();
DROP FUNCTION public."guardOutageDisbursementExceptionRecord"();
DROP FUNCTION public."validateOutageDisbursementLoan"(text);
DROP FUNCTION public."validOutageDisbursementException"(text, text, text, timestamp without time zone, text);
DROP FUNCTION public."validOutageDisbursementExceptionRecord"(text, text, text, text);
DROP FUNCTION public."validOutageDisbursementExceptionValues"(text, text, "ComplianceType", text, text, "ComplianceStatus", timestamp without time zone, jsonb);

-- DropForeignKey
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_tenantId_disbursementExceptionId_fkey";

-- DropIndex
DROP INDEX "LoanApplication_disbursementExceptionId_key";

-- DropIndex
DROP INDEX "LoanApplication_tenantId_disbursementExceptionId_key";

-- AlterTable
ALTER TABLE "LoanApplication" DROP COLUMN "disbursementExceptionId";

-- ---------------------------------------------------------------------------
-- Keep DISBURSEMENT_EXCEPTION records impossible.
--
-- The dropped ComplianceRecord_guard_outage_disbursement_exception trigger
-- refused every DISBURSEMENT_EXCEPTION insert (its evidence validator ended in
-- `AND FALSE`) and every update into that type, so no such row can exist. This
-- CHECK keeps that refusal (SQLSTATE 23514) without the trigger. VALID, because
-- no existing row can violate it. Self-contained: removing this block leaves
-- the rest of the migration intact.
-- ---------------------------------------------------------------------------
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_no_disbursement_exception" CHECK ((type <> 'DISBURSEMENT_EXCEPTION'::"ComplianceType"));
