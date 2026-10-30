-- CreateEnum
CREATE TYPE "RepaymentFrequency" AS ENUM ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "RepaymentStructure" AS ENUM ('AMORTISING', 'INTEREST_ONLY', 'BULLET');

-- CreateEnum
CREATE TYPE "GraceKind" AS ENUM ('NONE', 'PRINCIPAL_ONLY', 'FULL');

-- AlterTable
ALTER TABLE "LoanProduct" ADD COLUMN "repaymentStructured" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProductVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "minAmount" INTEGER NOT NULL,
    "maxAmount" INTEGER NOT NULL,
    "minTermDays" INTEGER NOT NULL,
    "maxTermDays" INTEGER NOT NULL,
    "interestRatePm" DOUBLE PRECISION NOT NULL,
    "interestModel" "InterestModel" NOT NULL,
    "initiationFeeModel" "InitiationFeeModel" NOT NULL,
    "initiationFeePct" DOUBLE PRECISION NOT NULL,
    "initiationFeeMax" INTEGER NOT NULL,
    "monthlyServiceFee" INTEGER NOT NULL,
    "frequency" "RepaymentFrequency",
    "structure" "RepaymentStructure",
    "graceKind" "GraceKind",
    "graceInstalments" INTEGER NOT NULL DEFAULT 0,
    "collateral" JSONB NOT NULL,
    "eligibility" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "changeRequestId" TEXT NOT NULL,
    "appliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPricingRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "segment" TEXT,
    "channel" TEXT,
    "riskRankMin" INTEGER,
    "riskRankMax" INTEGER,
    "campaignCode" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "rateMode" TEXT NOT NULL,
    "rateValue" DOUBLE PRECISION NOT NULL,
    "initiationFeePct" DOUBLE PRECISION,
    "changeRequestId" TEXT NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "retiredByRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanTerms" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "productVersionId" TEXT NOT NULL,
    "frequency" "RepaymentFrequency",
    "structure" "RepaymentStructure",
    "graceKind" "GraceKind",
    "graceInstalments" INTEGER NOT NULL DEFAULT 0,
    "instalments" INTEGER,
    "baseRatePm" DOUBLE PRECISION NOT NULL,
    "interestRatePm" DOUBLE PRECISION NOT NULL,
    "pricingRuleId" TEXT,
    "pricingRuleName" TEXT,
    "pricingInputs" JSONB,
    "deferredInterest" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationPricingInput" (
    "applicationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segment" TEXT,
    "channel" TEXT,
    "campaignCode" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationPricingInput_pkey" PRIMARY KEY ("applicationId")
);

-- CreateIndex
CREATE INDEX "ProductVersion_tenantId_productId_effectiveFrom_idx" ON "ProductVersion"("tenantId", "productId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_tenantId_id_key" ON "ProductVersion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_tenantId_productId_version_key" ON "ProductVersion"("tenantId", "productId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_changeRequestId_key" ON "ProductVersion"("changeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVersion_tenantId_productId_effectiveFrom_key" ON "ProductVersion"("tenantId", "productId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ProductPricingRule_tenantId_productId_idx" ON "ProductPricingRule"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPricingRule_changeRequestId_key" ON "ProductPricingRule"("changeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPricingRule_tenantId_id_key" ON "ProductPricingRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LoanTerms_tenantId_productVersionId_idx" ON "LoanTerms"("tenantId", "productVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanTerms_tenantId_loanId_sequence_key" ON "LoanTerms"("tenantId", "loanId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationPricingInput_tenantId_applicationId_key" ON "ApplicationPricingInput"("tenantId", "applicationId");

-- AddForeignKey
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "LoanProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductPricingRule" ADD CONSTRAINT "ProductPricingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPricingRule" ADD CONSTRAINT "ProductPricingRule_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "LoanProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_tenantId_productVersionId_fkey" FOREIGN KEY ("tenantId", "productVersionId") REFERENCES "ProductVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApplicationPricingInput" ADD CONSTRAINT "ApplicationPricingInput_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPricingInput" ADD CONSTRAINT "ApplicationPricingInput_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ProductVersion ----------------------------------------------------------------

ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_numbers" CHECK (
  "version" >= 1
  AND "minAmount" > 0 AND "maxAmount" >= "minAmount"
  AND "minTermDays" > 0 AND "maxTermDays" >= "minTermDays"
  AND "interestRatePm" >= 0 AND "interestRatePm" < 1
  AND "initiationFeePct" >= 0 AND "initiationFeePct" <= 1
  AND "initiationFeeMax" >= 0 AND "monthlyServiceFee" >= 0
  AND length(btrim("reason")) >= 5 AND length("reason") <= 500
);

-- The repayment structure is all there or not at all, and its parts agree: a grace has a kind and periods or neither, a
-- principal-only grace belongs to an amortising structure, a bullet has no grace, and a daily-accrual product (a single
-- payment) has no structure.
ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_repayment" CHECK (
  ("frequency" IS NULL) = ("structure" IS NULL) AND ("structure" IS NULL) = ("graceKind" IS NULL)
  AND "graceInstalments" >= 0
  AND (("graceKind" IS NULL OR "graceKind" = 'NONE') = ("graceInstalments" = 0))
  AND ("structure" IS DISTINCT FROM 'BULLET' OR "graceKind" = 'NONE')
  AND ("graceKind" IS DISTINCT FROM 'PRINCIPAL_ONLY' OR "structure" = 'AMORTISING')
  AND ("interestModel" <> 'DAILY_ACCRUAL' OR "frequency" IS NULL)
);

ALTER TABLE "ProductVersion" ADD CONSTRAINT "ProductVersion_json_shapes" CHECK (
  jsonb_typeof("collateral") = 'array' AND jsonb_array_length("collateral") <= 20 AND jsonb_typeof("eligibility") = 'object'
);

-- A version exists only because an approved PRODUCT_VERSION request of this lender made it, equal to what was approved
-- (an effective date already past when it was approved starts on the approval day, so it may be later, never earlier),
-- and it never changes or goes away: the one write allowed is the activation stamping appliedAt, once.
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
    OR NEW."collateral" IS DISTINCT FROM cfg -> 'collateral'
    OR NEW."eligibility" IS DISTINCT FROM cfg -> 'eligibility'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A product version must equal the approved PRODUCT_VERSION change request''s payload';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ProductVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ProductVersion"
  FOR EACH ROW EXECUTE FUNCTION public."guardProductVersion"();
CREATE TRIGGER "ProductVersion_no_truncate" BEFORE TRUNCATE ON "ProductVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardProductVersion"();

-- ProductPricingRule ------------------------------------------------------------

ALTER TABLE "ProductPricingRule" ADD CONSTRAINT "ProductPricingRule_values" CHECK (
  length(btrim("name")) BETWEEN 1 AND 100
  AND ("riskRankMin" IS NULL) = ("riskRankMax" IS NULL)
  AND ("riskRankMin" IS NULL OR ("riskRankMin" >= 0 AND "riskRankMax" >= "riskRankMin" AND "riskRankMax" <= 50))
  AND ("validTo" IS NULL OR "validTo" >= "validFrom")
  AND "priority" BETWEEN 0 AND 1000
  AND "rateMode" IN ('SET', 'ADD')
  AND (("rateMode" = 'SET' AND "rateValue" >= 0 AND "rateValue" < 1) OR ("rateMode" = 'ADD' AND "rateValue" > -1 AND "rateValue" < 1))
  AND ("initiationFeePct" IS NULL OR ("initiationFeePct" >= 0 AND "initiationFeePct" <= 1))
  AND ("campaignCode" IS NULL OR "campaignCode" ~ '^[A-Z][A-Z0-9_]{1,39}$')
  AND ("segment" IS NULL OR length("segment") BETWEEN 1 AND 60)
  AND ("channel" IS NULL OR length("channel") BETWEEN 1 AND 60)
  AND ("retiredAt" IS NULL) = ("retiredByRequestId" IS NULL)
);

-- A rule exists only because an approved PRODUCT_PRICING_RULE request (action CREATE) of this lender made it, equal to
-- what was approved. It never changes or goes away, except that a second approved request (action RETIRE, naming this
-- rule) may retire it, once.
CREATE OR REPLACE FUNCTION public."guardProductPricingRule"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  req RECORD;
  r JSONB;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL
      AND to_jsonb(NEW) - 'retiredAt' - 'retiredByRequestId' = to_jsonb(OLD) - 'retiredAt' - 'retiredByRequestId'
      AND EXISTS (SELECT 1 FROM "ChangeRequest" c
        WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."retiredByRequestId" AND c."kind" = 'PRODUCT_PRICING_RULE'
          AND c."status" = 'APPROVED' AND c."payload" ->> 'action' = 'RETIRE' AND c."payload" ->> 'ruleId' = NEW."id") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pricing rule never changes or goes away: it is retired by an approved PRODUCT_PRICING_RULE request';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pricing rule never changes or goes away: it is retired by an approved PRODUCT_PRICING_RULE request';
  END IF;
  SELECT c."payload" INTO req FROM "ChangeRequest" c
    WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."changeRequestId" AND c."kind" = 'PRODUCT_PRICING_RULE'
      AND c."status" = 'APPROVED' AND c."payload" ->> 'action' = 'CREATE';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pricing rule is created only by an approved PRODUCT_PRICING_RULE change request (action CREATE)';
  END IF;
  r := req."payload" -> 'rule';
  IF NEW."productId" IS DISTINCT FROM r ->> 'productId'
    OR NEW."name" IS DISTINCT FROM r ->> 'name'
    OR NEW."segment" IS DISTINCT FROM r ->> 'segment'
    OR NEW."channel" IS DISTINCT FROM r ->> 'channel'
    OR NEW."riskRankMin" IS DISTINCT FROM (r ->> 'riskRankMin')::INTEGER
    OR NEW."riskRankMax" IS DISTINCT FROM (r ->> 'riskRankMax')::INTEGER
    OR NEW."campaignCode" IS DISTINCT FROM r ->> 'campaignCode'
    OR NEW."validFrom" IS DISTINCT FROM (r ->> 'validFrom')::DATE
    OR NEW."validTo" IS DISTINCT FROM (r ->> 'validTo')::DATE
    OR NEW."priority" IS DISTINCT FROM (r ->> 'priority')::INTEGER
    OR NEW."rateMode" IS DISTINCT FROM r -> 'rate' ->> 'mode'
    OR NEW."rateValue" IS DISTINCT FROM (r -> 'rate' ->> 'value')::DOUBLE PRECISION
    OR NEW."initiationFeePct" IS DISTINCT FROM (r ->> 'initiationFeePct')::DOUBLE PRECISION
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pricing rule must equal the approved PRODUCT_PRICING_RULE change request''s payload';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ProductPricingRule_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ProductPricingRule"
  FOR EACH ROW EXECUTE FUNCTION public."guardProductPricingRule"();
CREATE TRIGGER "ProductPricingRule_no_truncate" BEFORE TRUNCATE ON "ProductPricingRule"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardProductPricingRule"();

-- LoanTerms ---------------------------------------------------------------------

ALTER TABLE "LoanTerms" ADD CONSTRAINT "LoanTerms_values" CHECK (
  "baseRatePm" >= 0 AND "baseRatePm" < 1 AND "interestRatePm" >= 0 AND "interestRatePm" < 1
  AND ("frequency" IS NULL) = ("structure" IS NULL) AND ("structure" IS NULL) = ("graceKind" IS NULL) AND ("frequency" IS NULL) = ("instalments" IS NULL)
  AND "graceInstalments" >= 0
  AND (("graceKind" IS NULL OR "graceKind" = 'NONE') = ("graceInstalments" = 0))
  AND ("instalments" IS NULL OR ("instalments" >= 1 AND "graceInstalments" < "instalments"))
  AND ("structure" IS DISTINCT FROM 'BULLET' OR "graceKind" = 'NONE')
  AND ("graceKind" IS DISTINCT FROM 'PRINCIPAL_ONLY' OR "structure" = 'AMORTISING')
  AND (("pricingRuleId" IS NULL) = ("pricingRuleName" IS NULL))
  AND ("pricingRuleId" IS NOT NULL OR "interestRatePm" = "baseRatePm")
  AND "sequence" >= 1 AND "deferredInterest" >= 0
);

-- A loan keeps the terms it was written on: rows are only ever appended, numbered 1, 2, 3 ... per loan (sequence 1 is the
-- origination; a later restructure appends the terms that apply from then on), and none is ever changed or removed.
CREATE OR REPLACE FUNCTION public."guardLoanTerms"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  last INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The terms a loan was written on never change: a later change appends a row';
  END IF;
  SELECT COALESCE(MAX(t."sequence"), 0) INTO last FROM "LoanTerms" t WHERE t."tenantId" = NEW."tenantId" AND t."loanId" = NEW."loanId";
  IF NEW."sequence" <> last + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loan terms are appended in sequence: the next row for this loan is ' || (last + 1)::TEXT;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanTerms_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LoanTerms"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanTerms"();
CREATE TRIGGER "LoanTerms_no_truncate" BEFORE TRUNCATE ON "LoanTerms"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLoanTerms"();

-- ApplicationPricingInput -------------------------------------------------------

ALTER TABLE "ApplicationPricingInput" ADD CONSTRAINT "ApplicationPricingInput_values" CHECK (
  ("segment" IS NULL OR length("segment") BETWEEN 1 AND 60)
  AND ("channel" IS NULL OR length("channel") BETWEEN 1 AND 60)
  AND ("campaignCode" IS NULL OR "campaignCode" ~ '^[A-Z][A-Z0-9_]{1,39}$')
);

-- Tenant isolation (as 20261029100000_maker_checker_decision_rules) ---------------

ALTER TABLE "ProductVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ProductVersion" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ProductPricingRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProductPricingRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ProductPricingRule" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LoanTerms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanTerms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanTerms" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ApplicationPricingInput" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApplicationPricingInput" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApplicationPricingInput" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
