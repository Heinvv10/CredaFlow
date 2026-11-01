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

ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_balloon" CHECK (
  "balloonCents" >= 0
  AND ("balloonCents" = 0 OR "structure" = 'BALLOON')
  AND ("structure" IS DISTINCT FROM 'BALLOON' OR "graceKind" = 'NONE')
);

ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_variable_rate" CHECK (
  ("rateBasis" IS NULL) = ("rateMarginPa" IS NULL)
  AND ("rateBasis" IS NULL) = ("referenceRate" IS NULL)
  AND ("rateBasis" IS NULL) = ("referenceEffectiveDate" IS NULL)
  AND ("referenceRate" IS NULL OR ("referenceRate" > 0 AND "referenceRate" < 1))
);

-- One repricing per loan per reference change: the backstop to the loan lock (lib/product-engine/reprice-loan.ts).
CREATE UNIQUE INDEX "LoanTerms_reference_effective_key" ON "LoanTerms"("tenantId", "loanId", "referenceEffectiveDate") WHERE "referenceEffectiveDate" IS NOT NULL;

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
