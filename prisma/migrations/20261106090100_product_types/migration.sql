-- A5b (docs/product-engine/DESIGN.md): a balloon structure, a variable rate tied to a reference rate, and the application facts
-- and borrower groups the salary-backed, SME and group product types need.

-- AlterTable
ALTER TABLE "ProductVersion" ADD COLUMN "balloonPct" DOUBLE PRECISION,
ADD COLUMN "rateBasis" "ReferenceRateBasis",
ADD COLUMN "rateMarginPa" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "LoanTerms" ADD COLUMN "balloonCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "rateBasis" "ReferenceRateBasis",
ADD COLUMN "rateMarginPa" DOUBLE PRECISION,
ADD COLUMN "referenceRate" DOUBLE PRECISION,
ADD COLUMN "referenceEffectiveDate" DATE;

-- CreateTable
CREATE TABLE "ApplicationProductFacts" (
    "applicationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employerName" TEXT,
    "payrollNumber" TEXT,
    "businessName" TEXT,
    "businessRegistrationNumber" TEXT,
    "annualTurnoverCents" BIGINT,
    "borrowerGroupId" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationProductFacts_pkey" PRIMARY KEY ("applicationId")
);

-- CreateTable
CREATE TABLE "BorrowerGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorrowerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BorrowerGroupMember" (
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BorrowerGroupMember_pkey" PRIMARY KEY ("tenantId","groupId","clientId")
);

-- CreateIndex
CREATE INDEX "ApplicationProductFacts_tenantId_borrowerGroupId_idx" ON "ApplicationProductFacts"("tenantId", "borrowerGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationProductFacts_tenantId_applicationId_key" ON "ApplicationProductFacts"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "BorrowerGroup_tenantId_id_key" ON "BorrowerGroup"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BorrowerGroup_tenantId_name_key" ON "BorrowerGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "BorrowerGroupMember_tenantId_clientId_idx" ON "BorrowerGroupMember"("tenantId", "clientId");

-- AddForeignKey
ALTER TABLE "ApplicationProductFacts" ADD CONSTRAINT "ApplicationProductFacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationProductFacts" ADD CONSTRAINT "ApplicationProductFacts_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApplicationProductFacts" ADD CONSTRAINT "ApplicationProductFacts_tenantId_borrowerGroupId_fkey" FOREIGN KEY ("tenantId", "borrowerGroupId") REFERENCES "BorrowerGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BorrowerGroup" ADD CONSTRAINT "BorrowerGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowerGroupMember" ADD CONSTRAINT "BorrowerGroupMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowerGroupMember" ADD CONSTRAINT "BorrowerGroupMember_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "BorrowerGroup"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BorrowerGroupMember" ADD CONSTRAINT "BorrowerGroupMember_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A balloon: a share of the principal left to the last instalment. It has no grace (lib/product-engine/grace-rules.ts).
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_balloon" CHECK (
  ("structure" IS NOT DISTINCT FROM 'BALLOON') = ("balloonPct" IS NOT NULL)
  AND ("balloonPct" IS NULL OR ("balloonPct" > 0 AND "balloonPct" < 1))
  AND ("structure" IS DISTINCT FROM 'BALLOON' OR "graceKind" = 'NONE')
);

-- A variable rate names a reference and a margin, or neither, and only a structure a repricing can regenerate takes one: a
-- reducing balance, repaid over several rows, with no interest deferred by a full grace.
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_variable_rate" CHECK (
  ("rateBasis" IS NULL) = ("rateMarginPa" IS NULL)
  AND ("rateBasis" IS NULL OR (
    "rateBasis" IN ('PRIME', 'LENDER_BASE')
    AND "rateMarginPa" > -1 AND "rateMarginPa" < 1
    AND "interestModel" = 'REDUCING_BALANCE'
    AND "structure" IN ('AMORTISING', 'INTEREST_ONLY', 'BALLOON')
    AND "graceKind" <> 'FULL'
  ))
);

-- Unlike a version's, a loan's terms may show a grace on a balloon: a payment holiday (lib/loan-changes) records one.
ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_balloon" CHECK (
  "balloonCents" >= 0
  AND ("balloonCents" = 0 OR "structure" = 'BALLOON')
);

ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_variable_rate" CHECK (
  ("rateBasis" IS NULL) = ("rateMarginPa" IS NULL)
  AND ("rateBasis" IS NULL) = ("referenceRate" IS NULL)
  AND ("rateBasis" IS NULL) = ("referenceEffectiveDate" IS NULL)
  AND ("referenceRate" IS NULL OR ("referenceRate" > 0 AND "referenceRate" < 1))
);

-- A version equals its approved request: the new columns are compared with the rest.
CREATE OR REPLACE FUNCTION public."guardProductVersion"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  req RECORD;
  cfg JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."appliedAt" IS NULL AND NEW."appliedAt" IS NOT NULL
      AND to_jsonb(NEW) - 'appliedAt' = to_jsonb(OLD) - 'appliedAt' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A product version never changes or goes away: approve a new version';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A product version never changes or goes away: approve a new version';
  END IF;
  SELECT c."payload" INTO req FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'PRODUCT_VERSION' AND c."status" = 'APPROVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A product version is created only by an approved PRODUCT_VERSION change request';
  END IF;
  cfg := req."payload" -> 'config';
  IF NEW."productId" IS DISTINCT FROM req."payload" ->> 'productId'
    OR NEW."effectiveFrom" IS DISTINCT FROM GREATEST((req."payload" ->> 'effectiveFrom')::DATE, (now() AT TIME ZONE 'Africa/Johannesburg')::DATE)
    OR NEW."reason" IS DISTINCT FROM req."payload" ->> 'reason'
    OR NEW."minAmount" IS DISTINCT FROM (cfg ->> 'minAmountCents')::INTEGER
    OR NEW."maxAmount" IS DISTINCT FROM (cfg ->> 'maxAmountCents')::INTEGER
    OR NEW."minTermDays" IS DISTINCT FROM (cfg ->> 'minTermDays')::INTEGER
    OR NEW."maxTermDays" IS DISTINCT FROM (cfg ->> 'maxTermDays')::INTEGER
    OR NEW."interestRatePm" IS DISTINCT FROM (cfg ->> 'interestRatePm')::DOUBLE PRECISION
    OR NEW."interestModel"::TEXT IS DISTINCT FROM cfg ->> 'interestModel'
    OR NEW."initiationFeeModel"::TEXT IS DISTINCT FROM cfg ->> 'initiationFeeModel'
    OR NEW."initiationFeePct" IS DISTINCT FROM (cfg ->> 'initiationFeePct')::DOUBLE PRECISION
    OR NEW."initiationFeeMax" IS DISTINCT FROM (cfg ->> 'initiationFeeMaxCents')::INTEGER
    OR NEW."monthlyServiceFee" IS DISTINCT FROM (cfg ->> 'monthlyServiceFeeCents')::INTEGER
    OR NEW."frequency"::TEXT IS DISTINCT FROM cfg -> 'repayment' ->> 'frequency'
    OR NEW."structure"::TEXT IS DISTINCT FROM cfg -> 'repayment' ->> 'structure'
    OR NEW."graceKind"::TEXT IS DISTINCT FROM cfg -> 'repayment' ->> 'graceKind'
    OR NEW."graceInstalments" IS DISTINCT FROM COALESCE((cfg -> 'repayment' ->> 'graceInstalments')::INTEGER, 0)
    OR NEW."balloonPct" IS DISTINCT FROM (cfg -> 'repayment' ->> 'balloonPct')::DOUBLE PRECISION
    OR NEW."rateBasis"::TEXT IS DISTINCT FROM cfg -> 'variableRate' ->> 'basis'
    OR NEW."rateMarginPa" IS DISTINCT FROM (cfg -> 'variableRate' ->> 'marginPa')::DOUBLE PRECISION
    OR NEW."collateral" IS DISTINCT FROM cfg -> 'collateral'
    OR NEW."eligibility" IS DISTINCT FROM cfg -> 'eligibility'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A product version must equal the approved PRODUCT_VERSION change request''s payload';
  END IF;
  RETURN NEW;
END;
$function$;

-- Terms are appended in sequence, and a reference repricing appends them with no person involved: such a row must come from an
-- APPROVED reference value on the loan's own basis, keep its margin and structure, and carry the rate that value gives. Every other
-- later row keeps the rule of the loan changes (20261101100100_loan_changes): an approved LOAN_CHANGE of this loan.
CREATE OR REPLACE FUNCTION public."guardLoanTerms"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  last INTEGER;
  prev RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The terms a loan was written on never change: a later change appends a row';
  END IF;
  SELECT COALESCE(MAX(t."sequence"), 0) INTO last FROM "LoanTerms" t WHERE t."tenantId" = NEW."tenantId" AND t."loanId" = NEW."loanId";
  IF NEW."sequence" <> last + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loan terms are appended in sequence: the next row for this loan is ' || (last + 1)::TEXT;
  END IF;
  IF NEW."sequence" > 1 AND NEW."referenceEffectiveDate" IS NOT NULL AND NEW."changeRequestId" IS NULL THEN
    SELECT t."rateBasis", t."rateMarginPa", t."referenceEffectiveDate", t."frequency", t."structure", t."graceKind", t."graceInstalments", t."instalments", t."balloonCents"
      INTO prev FROM "LoanTerms" t
      WHERE t."tenantId" = NEW."tenantId" AND t."loanId" = NEW."loanId" AND t."sequence" = last;
    IF prev."rateBasis" IS DISTINCT FROM NEW."rateBasis" OR prev."rateMarginPa" IS DISTINCT FROM NEW."rateMarginPa"
      OR prev."referenceEffectiveDate" >= NEW."referenceEffectiveDate"
      OR prev."frequency" IS DISTINCT FROM NEW."frequency" OR prev."structure" IS DISTINCT FROM NEW."structure"
      OR prev."graceKind" IS DISTINCT FROM NEW."graceKind" OR prev."graceInstalments" IS DISTINCT FROM NEW."graceInstalments"
      OR prev."instalments" IS DISTINCT FROM NEW."instalments" OR prev."balloonCents" IS DISTINCT FROM NEW."balloonCents"
      OR abs(NEW."interestRatePm" - GREATEST(0, (NEW."referenceRate" + NEW."rateMarginPa") / 12)) > 0.00000001
      OR NOT EXISTS (
        SELECT 1 FROM "ReferenceRate" r
        WHERE r."tenantId" = NEW."tenantId" AND r."basis" = NEW."rateBasis" AND r."effectiveDate" = NEW."referenceEffectiveDate"
          AND r."status" = 'APPROVED' AND r."rate"::DOUBLE PRECISION = NEW."referenceRate"
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repricing follows an approved reference rate on the loan''s own basis, margin and structure';
    END IF;
    RETURN NEW;
  END IF;
  -- The request is this loan's: the one it changed, or the one whose application booked it.
  IF (NEW."sequence" > 1 OR NEW."changeRequestId" IS NOT NULL) AND NOT EXISTS (
    SELECT 1 FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'LOAN_CHANGE' AND c."status" = 'APPROVED'
      AND (c."payload" ->> 'loanId' = NEW."loanId" OR EXISTS (
        SELECT 1 FROM "Loan" l JOIN "LoanApplication" a ON a."id" = l."applicationId"
        WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND a."loanChangeRequestId" = c."id"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Later terms are appended only by an approved LOAN_CHANGE request';
  END IF;
  RETURN NEW;
END;
$function$;

-- affordabilityInputSha256 hashes what affordabilityInputFingerprint (lib/affordability/snapshot.ts) hashes: the balloon's share and a variable
-- rate are added to both, or approvalEvidenceIsIntact refuses every approval of such a version. Neither is present on any other approval,
-- which hashes exactly as before.
CREATE OR REPLACE FUNCTION public."affordabilityInputSha256"(p_inputs jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  canonical JSONB;
BEGIN
  IF JSONB_TYPEOF(p_inputs) <> 'object' THEN
    RETURN NULL;
  END IF;

  canonical := JSONB_BUILD_ARRAY(
    p_inputs -> 'monthlyIncomeCents',
    p_inputs -> 'monthlyExpensesCents',
    p_inputs -> 'applicationDebtCents',
    p_inputs -> 'clientDebtCents',
    p_inputs -> 'declaredDebtCents',
    p_inputs -> 'bureauObligationsCents',
    p_inputs -> 'proposedInstalmentCents',
    p_inputs -> 'principalCents',
    p_inputs -> 'termDays',
    p_inputs -> 'productId',
    p_inputs -> 'interestRatePm',
    p_inputs -> 'interestModel',
    p_inputs -> 'initiationFeePct',
    p_inputs -> 'initiationFeeMaxCents',
    p_inputs -> 'monthlyServiceFeeCents',
    p_inputs -> 'initiationFeePayment',
    p_inputs -> 'ndiBufferPct'
  );
  IF p_inputs ? 'creditLifePremiumCents' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      p_inputs -> 'creditLifePremiumCents'
    );
  END IF;
  IF p_inputs ? 'repayment' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'repayment:' || "jsonArrayText"(JSONB_BUILD_ARRAY(
        p_inputs #> '{repayment,frequency}',
        p_inputs #> '{repayment,structure}',
        p_inputs #> '{repayment,graceKind}',
        p_inputs #> '{repayment,graceInstalments}',
        p_inputs #> '{repayment,instalments}'
      ) || CASE WHEN p_inputs -> 'repayment' ? 'balloonPct' THEN JSONB_BUILD_ARRAY(p_inputs #> '{repayment,balloonPct}') ELSE '[]'::JSONB END)
    );
  END IF;
  IF p_inputs ? 'borrowerIdentity' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'identity:' || (p_inputs ->> 'borrowerIdentity')
    );
  END IF;
  IF p_inputs ? 'variableRate' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'variable:' || "jsonArrayText"(JSONB_BUILD_ARRAY(
        p_inputs #> '{variableRate,basis}',
        p_inputs #> '{variableRate,marginPa}',
        p_inputs #> '{variableRate,referenceRate}',
        p_inputs #> '{variableRate,referenceEffectiveDate}'
      ))
    );
  END IF;
  IF p_inputs ? 'productVersion' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      'version:' || "jsonArrayText"(JSONB_BUILD_ARRAY(
        p_inputs #> '{productVersion,id}',
        p_inputs #> '{productVersion,version}',
        p_inputs #> '{productVersion,baseRatePm}',
        p_inputs #> '{productVersion,pricingRuleId}'
      ))
    );
  END IF;
  RETURN "jsonArraySha256"(canonical);
END;
$function$;

-- guardSignedDebitMandateAuthority holds an approval's rate to the LoanProduct row or a pricing rule, so a variable rate, which prices off the
-- reference, was refused and decide answered 500. A rate off the row now also stands as what a variable version gives: outside the NCA only,
-- on the version of this product named in the approval, from an APPROVED reference value of its basis, at reference + the version's margin
-- (floored at 0), with a live rule applied to that base if one priced it.
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef('public."guardSignedDebitMandateAuthority"()'::regprocedure) INTO definition;
  changed := replace(definition,
    $sql$AND (new_approval #>> '{inputs,interestRatePm}' = TO_JSONB(product."interestRatePm")::TEXT OR ($sql$,
    $sql$AND (new_approval #>> '{inputs,interestRatePm}' = TO_JSONB(product."interestRatePm")::TEXT OR (
              (NEW."disclosureRegime" = 'KEY_FACTS' OR NEW."ncaRegime" IS NOT DISTINCT FROM 'NON_NCA')
              AND EXISTS (SELECT 1 FROM "ProductVersion" AS version JOIN "ReferenceRate" AS reference
                  ON reference."tenantId" = version."tenantId" AND reference."basis" = version."rateBasis"
                WHERE version."id" = new_approval #>> '{inputs,productVersion,id}' AND version."tenantId" = NEW."tenantId" AND version."productId" = product."id"
                  AND reference."status" = 'APPROVED'
                  AND reference."basis"::TEXT = new_approval #>> '{inputs,variableRate,basis}'
                  AND reference."effectiveDate" = (new_approval #>> '{inputs,variableRate,referenceEffectiveDate}')::DATE
                  AND reference."rate"::DOUBLE PRECISION = (new_approval #>> '{inputs,variableRate,referenceRate}')::DOUBLE PRECISION
                  AND ABS((new_approval #>> '{inputs,productVersion,baseRatePm}')::DOUBLE PRECISION - GREATEST(0, (reference."rate"::DOUBLE PRECISION + version."rateMarginPa") / 12)) <= 1e-7
                  AND ABS((new_approval #>> '{inputs,interestRatePm}')::DOUBLE PRECISION - GREATEST(0, (reference."rate"::DOUBLE PRECISION + (new_approval #>> '{inputs,variableRate,marginPa}')::DOUBLE PRECISION) / 12)) <= 1e-7)
              AND (new_approval #>> '{inputs,productVersion,pricingRuleId}' IS NOT NULL
                OR ABS((new_approval #>> '{inputs,interestRatePm}')::DOUBLE PRECISION - (new_approval #>> '{inputs,productVersion,baseRatePm}')::DOUBLE PRECISION) <= 1e-7
              )
              AND (new_approval #>> '{inputs,productVersion,pricingRuleId}' IS NULL OR EXISTS (SELECT 1 FROM "ProductPricingRule" AS rule
                WHERE rule."id" = new_approval #>> '{inputs,productVersion,pricingRuleId}' AND rule."tenantId" = NEW."tenantId"
                  AND (rule."productId" IS NULL OR rule."productId" = product."id") AND rule."retiredAt" IS NULL
                  AND rule."validFrom" <= (now() AT TIME ZONE 'Africa/Johannesburg')::DATE
                  AND (rule."validTo" IS NULL OR rule."validTo" >= (now() AT TIME ZONE 'Africa/Johannesburg')::DATE)
                  AND ABS((new_approval #>> '{inputs,interestRatePm}')::DOUBLE PRECISION - CASE rule."rateMode" WHEN 'SET' THEN rule."rateValue" ELSE GREATEST(0, (new_approval #>> '{inputs,productVersion,baseRatePm}')::DOUBLE PRECISION + rule."rateValue") END) <= 1e-7))
            ) OR ($sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardSignedDebitMandateAuthority rate shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

-- The facts of an application are what staff typed: bounded, and a figure is not negative.
ALTER TABLE "ApplicationProductFacts" ADD CONSTRAINT "ApplicationProductFacts_values" CHECK (
  ("employerName" IS NULL OR length(btrim("employerName")) BETWEEN 2 AND 120)
  AND ("payrollNumber" IS NULL OR length(btrim("payrollNumber")) BETWEEN 1 AND 40)
  AND ("businessName" IS NULL OR length(btrim("businessName")) BETWEEN 2 AND 120)
  AND ("businessRegistrationNumber" IS NULL OR length(btrim("businessRegistrationNumber")) BETWEEN 1 AND 40)
  AND ("annualTurnoverCents" IS NULL OR "annualTurnoverCents" > 0)
);

ALTER TABLE "BorrowerGroup" ADD CONSTRAINT "BorrowerGroup_name" CHECK (length(btrim("name")) BETWEEN 2 AND 100);

-- Tenant isolation (as 20261031120000_product_engine) ---------------------------

ALTER TABLE "ApplicationProductFacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApplicationProductFacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApplicationProductFacts" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BorrowerGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BorrowerGroup" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BorrowerGroup" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "BorrowerGroupMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BorrowerGroupMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "BorrowerGroupMember" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
