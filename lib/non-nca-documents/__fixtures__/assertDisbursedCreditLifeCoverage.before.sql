CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCoverage"(target_application_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_status "AppStatus";
  application_disbursed_at TIMESTAMP(3);
  application_tenant_id TEXT;
  application_client_id TEXT;
  application_entity_id TEXT;
  application_nca_regime "NcaRegime";
  application_rule TEXT;
  loan_id TEXT;
  loan_tenant_id TEXT;
  loan_client_id TEXT;
  loan_entity_id TEXT;
  loan_nca_regime "NcaRegime";
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
    application."entityId",
    application."ncaRegime",
    application."ncaClassificationRule",
    loan."id",
    loan."tenantId",
    loan."clientId",
    loan."entityId",
    loan."ncaRegime",
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    application_status,
    application_disbursed_at,
    application_tenant_id,
    application_client_id,
    application_entity_id,
    application_nca_regime,
    application_rule,
    loan_id,
    loan_tenant_id,
    loan_client_id,
    loan_entity_id,
    loan_nca_regime,
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

  IF loan_id IS NOT NULL
     AND loan_nca_regime IS DISTINCT FROM COALESCE(application_nca_regime, 'NCA'::"NcaRegime") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A loan''s NCA regime must be its application''s at commit';
  END IF;

  IF loan_nca_regime = 'NON_NCA' AND (
    application_status <> 'DISBURSED'::"AppStatus"
    OR application_disbursed_at IS NULL
    OR loan_tenant_id IS DISTINCT FROM application_tenant_id
    OR (application_rule IS DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT' AND (
      loan_client_id IS NOT NULL OR application_client_id IS NOT NULL OR loan_entity_id IS NULL))
    OR loan_client_id IS DISTINCT FROM application_client_id
    OR loan_entity_id IS DISTINCT FROM application_entity_id
    OR (application_rule = 'LARGE_AGREEMENT' AND loan_principal < 25000000)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A NON_NCA loan commits only with its application DISBURSED, NON_NCA, for the same entity and at a principal its classification allows';
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

  -- Credit life attaches to NCA credit agreements only; a NON_NCA (juristic)
  -- deal keeps the commit-together rule above and nothing after it.
  IF application_nca_regime = 'NON_NCA' THEN
    RETURN;
  END IF;

  IF application_entity_id IS NOT NULL AND application_nca_regime = 'NCA' THEN
    IF loan_entity_id IS DISTINCT FROM application_entity_id OR loan_client_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."id"=target_application_id AND a."creditLifeElection"='DECLINED')
      OR EXISTS (SELECT 1 FROM "InsurancePolicy" p WHERE p."linkedLoanId"=loan_id AND p."type"='CREDIT_LIFE' AND p."policySource"='BUNDLED_CREDIT_AGREEMENT') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA loan requires its matched entity, declined credit life and no bundled policy';
    END IF;
    RETURN;
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
$function$

