ALTER TABLE "AssetFinanceDeal" ADD COLUMN "clientId" TEXT;
ALTER TABLE "AssetFinanceDeal" ALTER COLUMN "entityId" DROP NOT NULL;

ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_borrower_xor"
CHECK (("clientId" IS NOT NULL)::INTEGER + ("entityId" IS NOT NULL)::INTEGER = 1);

ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_clientId_fkey"
FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id")
ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "AssetFinanceDeal_clientId_idx" ON "AssetFinanceDeal"("clientId");

ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_nca_classification_rule_known";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_nca_classification_rule_known" CHECK (
  "ncaClassificationRule" IS NULL OR "ncaClassificationRule" IN ('NATURAL_PERSON_NCA', 'TRUST_FEW_NATURAL_TRUSTEES', 'TRUST_UNEVIDENCED',
    'FINANCIALS_UNPROVEN', 'JURISTIC_OVER_THRESHOLD', 'LARGE_AGREEMENT', 'JURISTIC_SMALL_AGREEMENT')
);
ALTER TABLE "NcaRegimeOverride" DROP CONSTRAINT "NcaRegimeOverride_approved_classification_rule_known";
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_approved_classification_rule_known" CHECK (
  "approvedClassificationRule" IS NULL OR "approvedClassificationRule" IN ('NATURAL_PERSON_NCA', 'TRUST_FEW_NATURAL_TRUSTEES', 'TRUST_UNEVIDENCED',
    'FINANCIALS_UNPROVEN', 'JURISTIC_OVER_THRESHOLD', 'LARGE_AGREEMENT', 'JURISTIC_SMALL_AGREEMENT')
);

CREATE TABLE "AssetFinanceAffordabilityAssessment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "verifiedBusinessIncomeCents" BIGINT NOT NULL,
  "businessNdiBeforeProposedCents" BIGINT NOT NULL,
  "personalNdiCents" BIGINT,
  "proposedInstalmentCents" BIGINT NOT NULL,
  "combinedNdiAfterProposedCents" BIGINT NOT NULL,
  "affordable" BOOLEAN NOT NULL,
  "recklessLendingNote" TEXT NOT NULL,
  "assessedById" TEXT NOT NULL,
  "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssetFinanceAffordabilityAssessment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssetFinanceAffordabilityAssessment_note" CHECK (length(btrim("recklessLendingNote")) >= 10),
  CONSTRAINT "AssetFinanceAffordabilityAssessment_amounts" CHECK (
    "verifiedBusinessIncomeCents" >= 0 AND "proposedInstalmentCents" >= 0
  )
);
CREATE UNIQUE INDEX "AssetFinanceAffordabilityAssessment_dealId_key" ON "AssetFinanceAffordabilityAssessment"("dealId");
CREATE UNIQUE INDEX "AssetFinanceAffordabilityAssessment_tenantId_dealId_key" ON "AssetFinanceAffordabilityAssessment"("tenantId", "dealId");
ALTER TABLE "AssetFinanceAffordabilityAssessment" ADD CONSTRAINT "AssetFinanceAffordabilityAssessment_tenantId_dealId_fkey"
FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "AssetFinanceAffordabilityAssessment" ADD CONSTRAINT "AssetFinanceAffordabilityAssessment_tenantId_assessedById_fkey"
FOREIGN KEY ("tenantId", "assessedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION public."guardAssetFinanceNcaApproval"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE assessment_ok BOOLEAN;
BEGIN
  IF NEW."status" = 'APPROVED' AND OLD."status" IS DISTINCT FROM 'APPROVED'
     AND NEW."ncaRegime" = 'NCA'
     AND EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."id") THEN
    SELECT a."affordable" AND length(btrim(a."recklessLendingNote")) >= 10
      INTO assessment_ok
      FROM "AssetFinanceAffordabilityAssessment" a
      JOIN "AssetFinanceDeal" d ON d."id" = a."dealId" AND d."tenantId" = a."tenantId"
      WHERE d."applicationId" = NEW."id" AND a."tenantId" = NEW."tenantId";
    IF assessment_ok IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA asset approval requires an affordable s81 assessment and reckless-lending note';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanApplication_asset_nca_affordability" BEFORE UPDATE ON "LoanApplication"
FOR EACH ROW EXECUTE FUNCTION "guardAssetFinanceNcaApproval"();

CREATE OR REPLACE FUNCTION public."guardAssetFinanceAffordability"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE app_status "AppStatus";
BEGIN
  SELECT a."status" INTO app_status
    FROM "AssetFinanceDeal" d JOIN "LoanApplication" a ON a."id" = d."applicationId"
    WHERE d."id" = COALESCE(NEW."dealId", OLD."dealId") AND d."tenantId" = COALESCE(NEW."tenantId", OLD."tenantId");
  IF app_status IN ('APPROVED', 'DECLINED', 'DISBURSED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance affordability assessment is frozen after decision';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE TRIGGER "AssetFinanceAffordability_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssetFinanceAffordabilityAssessment"
FOR EACH ROW EXECUTE FUNCTION "guardAssetFinanceAffordability"();

-- Fail closed at the booking boundary. Application code gives a friendly
-- refusal; this trigger prevents a direct or stale writer from booking an
-- NCA asset agreement above the gazetted caps.
CREATE OR REPLACE FUNCTION public."guardAssetFinanceNcaCaps"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE repo_rate NUMERIC;
DECLARE annual_rate NUMERIC;
DECLARE tiered_fee BIGINT;
DECLARE initiation_cap BIGINT;
BEGIN
  IF NEW."ncaRegime" = 'NCA' AND NEW."contractType" IN ('INSTALMENT_SALE', 'FINANCE_LEASE')
     AND EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."applicationId") THEN
    SELECT r."rate" INTO repo_rate FROM "ReferenceRate" r
      WHERE r."tenantId" = NEW."tenantId" AND r."basis" = 'REPO' AND r."status" = 'APPROVED'
        AND r."effectiveDate" <= NEW."startDate"::date
      ORDER BY r."effectiveDate" DESC LIMIT 1;
    IF repo_rate IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA asset booking requires an approved REPO rate for its cap';
    END IF;
    annual_rate := NEW."interestRatePm" * 12;
    IF annual_rate > repo_rate + 0.17 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA asset annual interest exceeds REPO plus 17 percentage points';
    END IF;
    tiered_fee := ROUND(LEAST(105000, 16500 + GREATEST(0, NEW."principal" - 100000) * 0.10) * 1.15);
    initiation_cap := LEAST(tiered_fee, ROUND(NEW."principal" * 0.15));
    IF NEW."initiationFee" > initiation_cap THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA asset initiation fee exceeds the prescribed maximum';
    END IF;
    IF NEW."monthlyServiceFee" > 6000 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA asset monthly service fee exceeds the prescribed maximum';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Loan_asset_nca_caps" BEFORE INSERT OR UPDATE OF "interestRatePm", "initiationFee", "monthlyServiceFee", "startDate" ON "Loan"
FOR EACH ROW EXECUTE FUNCTION "guardAssetFinanceNcaCaps"();
