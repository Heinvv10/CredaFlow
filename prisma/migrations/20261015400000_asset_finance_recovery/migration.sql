-- Asset finance slice 4a: legal matters, recovery, remarketing and the surplus
-- refund (docs/asset-finance/SLICE4.md). Additive: new enums and enum values,
-- TenantConfig columns with defaults, seven new tables, then their database
-- rules (hand-written below the generated DDL). Every legal or tax rule is
-- UNTESTED against the law until the lender's legal team and tax adviser sign
-- it off; the database suites prove each rule refuses its violation, not that
-- the rule is the law: RUN_ASSET_FINANCE_RECOVERY_IT=1,
-- lib/asset-finance/recovery-rules-*.integration.test.ts.
--
-- guardAssetLessorStatus and guardAssetDealUnreleasedAsset are replaced to know
-- RECOVERED and SOLD_IN_REMARKETING; nothing sets those until a recovery
-- exists, so the running code is unaffected.

-- CreateEnum
CREATE TYPE "LegalMatterStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LegalMatterStepKind" AS ENUM ('LETTER_OF_DEMAND', 'S129_SENT', 'SUMMONS_ISSUED', 'SUMMONS_SERVED', 'JUDGMENT', 'ATTACHMENT_ORDER', 'SHERIFF_RETURN', 'ASSET_RECOVERED', 'SETTLED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RecoveryRoute" AS ENUM ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT', 'NON_NCA_VOLUNTARY', 'NON_NCA_COURT_ORDER');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('RECOVERED', 'VALUED', 'VALUATION_NOTICE_ISSUED', 'LISTED', 'SOLD', 'PROCEEDS_APPLIED', 'FINAL_NOTICE_ISSUED', 'SHORTFALL_OPEN', 'SURPLUS_HELD', 'CLOSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RecoveryCostType" AS ENUM ('TOWING', 'STORAGE', 'VALUATION', 'REPAIRS', 'ADVERTISING', 'AUCTION_COMMISSION', 'SHERIFF', 'INSURANCE', 'LEGAL_TAXED', 'LEGAL_CONTRACTUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "RecoveryCostTreatment" AS ENUM ('DEDUCT_FROM_PROCEEDS', 'CHARGE_TO_ACCOUNT');

-- CreateEnum
CREATE TYPE "SaleChannel" AS ENUM ('AUCTION', 'DEALER', 'PRIVATE_TENDER', 'DEBTOR_OR_SURETY');

-- CreateEnum
CREATE TYPE "RemarketingSaleStatus" AS ENUM ('PENDING_APPROVAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RemarketingBuyerType" AS ENUM ('PERSON', 'ENTITY');

-- CreateEnum
CREATE TYPE "RecoveryVatEventKind" AS ENUM ('REPOSSESSION_DEEMED_SUPPLY', 'LESSOR_RESALE');

-- CreateEnum
CREATE TYPE "RecoveryRefundStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'RELEASED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AssetLessorStatus" ADD VALUE 'RECOVERED';
ALTER TYPE "AssetLessorStatus" ADD VALUE 'SOLD_IN_REMARKETING';

-- AlterEnum
ALTER TYPE "EntityDocumentType" ADD VALUE 'LEGAL_DOCUMENT';

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "nonNcaDemandPeriodDays" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "recoveryNcaDeductibleCostTypes" "RecoveryCostType"[] DEFAULT ARRAY['TOWING', 'STORAGE', 'VALUATION', 'REPAIRS', 'ADVERTISING', 'AUCTION_COMMISSION', 'SHERIFF', 'INSURANCE']::"RecoveryCostType"[],
ADD COLUMN     "recoveryNonNcaChargeableCostTypes" "RecoveryCostType"[] DEFAULT ARRAY['TOWING', 'STORAGE', 'VALUATION', 'REPAIRS', 'ADVERTISING', 'AUCTION_COMMISSION', 'SHERIFF', 'INSURANCE', 'LEGAL_TAXED', 'LEGAL_CONTRACTUAL', 'OTHER']::"RecoveryCostType"[];

-- CreateTable
CREATE TABLE "LegalMatter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "attorneySupplierId" TEXT,
    "attorneyAppointedOn" DATE,
    "caseNumber" TEXT,
    "court" TEXT,
    "status" "LegalMatterStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalMatter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalMatterStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "matterId" TEXT NOT NULL,
    "kind" "LegalMatterStepKind" NOT NULL,
    "stepDate" DATE NOT NULL,
    "note" TEXT,
    "section129RecordId" TEXT,
    "correctsStepId" TEXT,
    "evidenceDocumentId" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalMatterStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recovery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "route" "RecoveryRoute" NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'RECOVERED',
    "surrenderRequestId" TEXT,
    "legalMatterId" TEXT,
    "recoveredOn" DATE NOT NULL,
    "location" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "meterReadingId" TEXT,
    "valuationId" TEXT,
    "valuationNoticePath" TEXT,
    "valuationNoticeSha256" TEXT,
    "finalNoticePath" TEXT,
    "finalNoticeSha256" TEXT,
    "settlementDueCents" INTEGER,
    "grossProceedsCents" INTEGER,
    "deductedCostsCents" INTEGER,
    "chargedCostsCents" INTEGER,
    "netProceedsCents" INTEGER,
    "shortfallCents" INTEGER,
    "surplusCents" INTEGER,
    "proceedsPaymentId" TEXT,
    "finalNoticeIssuedOn" DATE,
    "chargesFrozenFrom" DATE,
    "chargesFrozenUntil" DATE,
    "withdrawnReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCost" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recoveryId" TEXT NOT NULL,
    "type" "RecoveryCostType" NOT NULL,
    "netCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "supplierId" TEXT,
    "supplierInvoiceRef" TEXT NOT NULL,
    "incurredOn" DATE NOT NULL,
    "treatment" "RecoveryCostTreatment" NOT NULL,
    "legalStepId" TEXT,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemarketingSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recoveryId" TEXT NOT NULL,
    "status" "RemarketingSaleStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "channel" "SaleChannel" NOT NULL,
    "buyerType" "RemarketingBuyerType" NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerIdentifier" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "buyerVatNumber" TEXT,
    "priceInclVatCents" INTEGER NOT NULL,
    "valuationId" TEXT NOT NULL,
    "highestValuationCents" INTEGER NOT NULL,
    "belowValuation" BOOLEAN NOT NULL,
    "belowValuationReason" TEXT,
    "relatedPartyMatch" BOOLEAN NOT NULL,
    "screeningResult" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "taxInvoiceId" TEXT,
    "proceedsPaymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemarketingSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryVatEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recoveryId" TEXT NOT NULL,
    "kind" "RecoveryVatEventKind" NOT NULL,
    "eventDate" DATE NOT NULL,
    "dealContractType" "ContractType" NOT NULL,
    "debtorVatVendor" BOOLEAN NOT NULL,
    "debtorVatNumber" TEXT,
    "deemedSupplyValueCents" INTEGER NOT NULL,
    "inputTaxClaimCents" INTEGER NOT NULL,
    "outputTaxCents" INTEGER NOT NULL,
    "vatRateTenThousandths" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryVatEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryRefund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recoveryId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankVerifiedById" TEXT NOT NULL,
    "bankVerificationDocumentId" TEXT NOT NULL,
    "status" "RecoveryRefundStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalMatter_tenantId_loanId_idx" ON "LegalMatter"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalMatter_tenantId_id_key" ON "LegalMatter"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LegalMatterStep_tenantId_matterId_idx" ON "LegalMatterStep"("tenantId", "matterId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalMatterStep_tenantId_id_key" ON "LegalMatterStep"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Recovery_surrenderRequestId_key" ON "Recovery"("surrenderRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Recovery_proceedsPaymentId_key" ON "Recovery"("proceedsPaymentId");

-- CreateIndex
CREATE INDEX "Recovery_tenantId_loanId_idx" ON "Recovery"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "Recovery_tenantId_assetId_idx" ON "Recovery"("tenantId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "Recovery_tenantId_id_key" ON "Recovery"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Recovery_tenantId_surrenderRequestId_key" ON "Recovery"("tenantId", "surrenderRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Recovery_tenantId_proceedsPaymentId_key" ON "Recovery"("tenantId", "proceedsPaymentId");

-- CreateIndex
CREATE INDEX "RecoveryCost_tenantId_recoveryId_idx" ON "RecoveryCost"("tenantId", "recoveryId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCost_tenantId_id_key" ON "RecoveryCost"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RemarketingSale_taxInvoiceId_key" ON "RemarketingSale"("taxInvoiceId");

-- CreateIndex
CREATE INDEX "RemarketingSale_tenantId_recoveryId_idx" ON "RemarketingSale"("tenantId", "recoveryId");

-- CreateIndex
CREATE UNIQUE INDEX "RemarketingSale_tenantId_id_key" ON "RemarketingSale"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RemarketingSale_tenantId_taxInvoiceId_key" ON "RemarketingSale"("tenantId", "taxInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryVatEvent_tenantId_id_key" ON "RecoveryVatEvent"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryVatEvent_tenantId_recoveryId_kind_key" ON "RecoveryVatEvent"("tenantId", "recoveryId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRefund_recoveryId_key" ON "RecoveryRefund"("recoveryId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRefund_tenantId_id_key" ON "RecoveryRefund"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRefund_tenantId_recoveryId_key" ON "RecoveryRefund"("tenantId", "recoveryId");

-- AddForeignKey
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_tenantId_attorneySupplierId_fkey" FOREIGN KEY ("tenantId", "attorneySupplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_matterId_fkey" FOREIGN KEY ("tenantId", "matterId") REFERENCES "LegalMatter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_section129RecordId_fkey" FOREIGN KEY ("tenantId", "section129RecordId") REFERENCES "ComplianceRecord"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_correctsStepId_fkey" FOREIGN KEY ("tenantId", "correctsStepId") REFERENCES "LegalMatterStep"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_surrenderRequestId_fkey" FOREIGN KEY ("tenantId", "surrenderRequestId") REFERENCES "SurrenderRequest"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_legalMatterId_fkey" FOREIGN KEY ("tenantId", "legalMatterId") REFERENCES "LegalMatter"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_meterReadingId_fkey" FOREIGN KEY ("tenantId", "meterReadingId") REFERENCES "AssetMeterReading"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "AssetValuation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_proceedsPaymentId_fkey" FOREIGN KEY ("tenantId", "proceedsPaymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_legalStepId_fkey" FOREIGN KEY ("tenantId", "legalStepId") REFERENCES "LegalMatterStep"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "AssetValuation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_taxInvoiceId_fkey" FOREIGN KEY ("tenantId", "taxInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_proceedsPaymentId_fkey" FOREIGN KEY ("tenantId", "proceedsPaymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_bankVerificationDocumentId_fkey" FOREIGN KEY ("tenantId", "bankVerificationDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===========================================================================
-- Hand-written rules (Prisma does not diff these). Errors are 23514.
-- ===========================================================================

-- SA business days: the date `business_days` SA business days after `start_date`
-- (lib/compliance/sa-business-days.ts addSouthAfricanBusinessDays, same count).
CREATE OR REPLACE FUNCTION public."recoveryAddBusinessDays"(start_date DATE, business_days INTEGER)
RETURNS DATE LANGUAGE plpgsql STABLE STRICT AS $function$
DECLARE
  result DATE := start_date;
  remaining INTEGER := business_days;
BEGIN
  IF business_days < 0 THEN
    RAISE EXCEPTION 'Business-day count must not be negative';
  END IF;
  WHILE remaining > 0 LOOP
    result := result + 1;
    IF public."isSaBusinessDate"(result) THEN
      remaining := remaining - 1;
    END IF;
  END LOOP;
  RETURN result;
END;
$function$;

-- An identifier compared as the screening compares it (lib/asset-finance/recovery-screening.ts):
-- every non-alphanumeric stripped, upper case.
CREATE OR REPLACE FUNCTION public."recoveryIdentifierKey"(value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $function$
  SELECT upper(regexp_replace(COALESCE(value, ''), '[^A-Za-z0-9]', '', 'g'));
$function$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_recovery_settings" CHECK ("nonNcaDemandPeriodDays" BETWEEN 1 AND 90);

-- ---------------------------------------------------------------------------
-- Legal matter
-- ---------------------------------------------------------------------------
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_closed_columns" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL));
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_attorney_columns" CHECK (("attorneySupplierId" IS NULL) = ("attorneyAppointedOn" IS NULL));
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_creator" CHECK (length(btrim("createdById")) > 0);
CREATE UNIQUE INDEX "LegalMatter_one_open_per_loan" ON "LegalMatter"("tenantId", "loanId") WHERE "status" = 'OPEN';

CREATE OR REPLACE FUNCTION public."guardLegalMatter"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A legal matter is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A legal matter opens OPEN';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."loanId" IS DISTINCT FROM OLD."loanId"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A legal matter''s tenant, loan and creator are fixed';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed legal matter is final';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LegalMatter_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegalMatter"
  FOR EACH ROW EXECUTE FUNCTION public."guardLegalMatter"();
CREATE TRIGGER "LegalMatter_no_truncate" BEFORE TRUNCATE ON "LegalMatter"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLegalMatter"();

-- A matter has an effective step of this kind (one no later step corrects),
-- dated on or before `on_or_before` when that is given.
CREATE OR REPLACE FUNCTION public."legalMatterHasStep"(tenant_id TEXT, matter_id TEXT, step_kind TEXT, on_or_before DATE DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (SELECT 1 FROM "LegalMatterStep" s
    WHERE s."tenantId" = tenant_id AND s."matterId" = matter_id AND s."kind"::TEXT = step_kind
      AND (on_or_before IS NULL OR s."stepDate" <= on_or_before)
      AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id"));
$function$;

-- The matter's section 129 notice has matured: an effective S129_SENT step
-- whose date plus 10 SA business days is on or before `on_date`.
-- UNTESTED: s129(1)(a) / s130(1)(a) read as business days after the notice date.
CREATE OR REPLACE FUNCTION public."legalMatterS129Matured"(tenant_id TEXT, matter_id TEXT, on_date DATE)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (SELECT 1 FROM "LegalMatterStep" s
    WHERE s."tenantId" = tenant_id AND s."matterId" = matter_id AND s."kind" = 'S129_SENT'
      AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")
      AND public."recoveryAddBusinessDays"(s."stepDate", 10) <= on_date);
$function$;

ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_s129_record_only" CHECK ("section129RecordId" IS NULL OR "kind" = 'S129_SENT');
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_recorder" CHECK (length(btrim("recordedById")) > 0);

CREATE OR REPLACE FUNCTION public."guardLegalMatterStep"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  matter RECORD;
  regime TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A legal matter step is append-only: correct it with a new step';
  END IF;
  SELECT m."loanId", m."status"::TEXT AS status INTO matter
    FROM "LegalMatter" m WHERE m."id" = NEW."matterId" AND m."tenantId" = NEW."tenantId" FOR SHARE;
  IF NOT FOUND OR matter.status <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A step is recorded on an open legal matter';
  END IF;
  IF NEW."stepDate" > today THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A step is not dated in the future';
  END IF;
  SELECT l."ncaRegime"::TEXT INTO regime FROM "Loan" l WHERE l."id" = matter."loanId" AND l."tenantId" = NEW."tenantId";
  IF NEW."correctsStepId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "LegalMatterStep" s WHERE s."id" = NEW."correctsStepId" AND s."tenantId" = NEW."tenantId" AND s."matterId" = NEW."matterId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A step corrects a step of the same legal matter';
  END IF;
  IF NEW."evidenceDocumentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "EntityDocument" d WHERE d."id" = NEW."evidenceDocumentId" AND d."tenantId" = NEW."tenantId"
        AND d."docType" = 'LEGAL_DOCUMENT' AND d."deletedAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A step''s evidence is a live legal document';
  END IF;
  IF NEW."kind" = 'S129_SENT' THEN
    IF regime <> 'NCA' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A section 129 notice belongs to an NCA loan';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ComplianceRecord" c WHERE c."id" = NEW."section129RecordId" AND c."tenantId" = NEW."tenantId"
        AND c."referenceId" = matter."loanId" AND c."type" = 'SECTION_129_NOTICE' AND c."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A section 129 step names this loan''s completed section 129 notice record';
    END IF;
  END IF;
  -- UNTESTED: s129/s130 (NCA) and the lender's own demand practice (NON_NCA) are for its legal team to sign off.
  IF NEW."kind" = 'SUMMONS_ISSUED' THEN
    IF regime = 'NCA' THEN
      IF NOT public."legalMatterS129Matured"(NEW."tenantId", NEW."matterId", NEW."stepDate") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA summons needs a section 129 notice sent at least 10 business days earlier';
      END IF;
    ELSIF NOT public."legalMatterHasStep"(NEW."tenantId", NEW."matterId", 'LETTER_OF_DEMAND', NEW."stepDate") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA summons needs a letter of demand first';
    END IF;
  END IF;
  IF NEW."kind" = 'ATTACHMENT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."matterId", 'JUDGMENT', NEW."stepDate") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An attachment order needs a judgment on the matter first';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LegalMatterStep_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LegalMatterStep"
  FOR EACH ROW EXECUTE FUNCTION public."guardLegalMatterStep"();
CREATE TRIGGER "LegalMatterStep_no_truncate" BEFORE TRUNCATE ON "LegalMatterStep"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLegalMatterStep"();

-- ---------------------------------------------------------------------------
-- Recovery
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "Recovery_one_open_per_loan" ON "Recovery"("tenantId", "loanId") WHERE "status" NOT IN ('CLOSED', 'WITHDRAWN');

ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_surrender_route" CHECK (("route" = 'NCA_S127_SURRENDER') = ("surrenderRequestId" IS NOT NULL));
-- s127 keeps its notices on the SurrenderRequest; a NON_NCA recovery has no NCA notices at all.
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_s131_notices_only" CHECK ("route" = 'NCA_S131_ATTACHMENT'
  OR ("valuationNoticePath" IS NULL AND "valuationNoticeSha256" IS NULL AND "finalNoticePath" IS NULL AND "finalNoticeSha256" IS NULL));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_non_nca_no_final_notice_date" CHECK ("route" NOT IN ('NON_NCA_VOLUNTARY', 'NON_NCA_COURT_ORDER') OR "finalNoticeIssuedOn" IS NULL);
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_notice_shape" CHECK (
  (("valuationNoticePath" IS NULL) = ("valuationNoticeSha256" IS NULL))
  AND (("finalNoticePath" IS NULL) = ("finalNoticeSha256" IS NULL))
  AND ("valuationNoticeSha256" IS NULL OR "valuationNoticeSha256" ~ '^[0-9a-f]{64}$')
  AND ("finalNoticeSha256" IS NULL OR "finalNoticeSha256" ~ '^[0-9a-f]{64}$'));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_figures_all_or_none" CHECK (
  num_nulls("settlementDueCents", "grossProceedsCents", "deductedCostsCents", "chargedCostsCents", "netProceedsCents", "shortfallCents", "surplusCents") IN (0, 7));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_figures_nonnegative" CHECK (
  COALESCE("settlementDueCents", 0) >= 0 AND COALESCE("grossProceedsCents", 0) >= 0 AND COALESCE("deductedCostsCents", 0) >= 0
  AND COALESCE("chargedCostsCents", 0) >= 0 AND COALESCE("netProceedsCents", 0) >= 0 AND COALESCE("shortfallCents", 0) >= 0 AND COALESCE("surplusCents", 0) >= 0);
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_net_proceeds" CHECK ("netProceedsCents" IS NULL OR "netProceedsCents" = "grossProceedsCents" - "deductedCostsCents");
-- The owed figure is the settlement plus the costs charged to the account; the
-- result is its shortfall or surplus against the net proceeds, never both.
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_shortfall_surplus" CHECK ("shortfallCents" IS NULL OR (
  "shortfallCents" = GREATEST(0, "settlementDueCents" + "chargedCostsCents" - "netProceedsCents")
  AND "surplusCents" = GREATEST(0, "netProceedsCents" - "settlementDueCents" - "chargedCostsCents")));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_freeze_window" CHECK (("chargesFrozenUntil" IS NULL OR "chargesFrozenFrom" IS NOT NULL) AND ("chargesFrozenFrom" IS NULL OR "chargesFrozenUntil" IS NULL OR "chargesFrozenFrom" <= "chargesFrozenUntil"));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_closed_columns" CHECK (("status" IN ('CLOSED', 'WITHDRAWN')) = ("closedAt" IS NOT NULL) AND ("status" = 'WITHDRAWN') = ("withdrawnReason" IS NOT NULL));
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_text" CHECK (length(btrim("location")) >= 2 AND length(btrim("condition")) >= 3 AND length(btrim("createdById")) > 0);

CREATE OR REPLACE FUNCTION public."guardRecovery"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  surrender RECORD;
  config RECORD;
  costs RECORD;
  nca BOOLEAN;
  step TEXT;
  allowed TEXT[];
  changed TEXT[];
  expected_receipt INTEGER;
  receipt_total INTEGER;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is never deleted';
  END IF;
  nca := NEW."route" IN ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT');
  SELECT l."ncaRegime"::TEXT AS regime, l."contractType"::TEXT AS contract_type, l."assetId", l."status"::TEXT AS status INTO loan_row
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row.contract_type = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery belongs to an asset-finance loan and its financed asset';
  END IF;
  IF nca <> (loan_row.regime = 'NCA') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The recovery route must match the loan''s NCA regime';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA court-order recovery needs the legal matter''s judgment';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CLOSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed or withdrawn recovery is final';
  END IF;
  -- The columns this step may write. Everything else is fixed: the loan, asset, route, surrender,
  -- legal matter, date and creator from the start, and the valuation, notices, figures, payment and
  -- freeze dates once written, because each is written by exactly one step.
  step := OLD."status"::TEXT || '>' || NEW."status"::TEXT;
  IF OLD."status" = NEW."status" THEN
    allowed := ARRAY['location', 'condition', 'meterReadingId'];
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil'];
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    allowed := ARRAY['finalNoticeIssuedOn', 'finalNoticePath', 'finalNoticeSha256', 'chargesFrozenUntil'];
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED', 'SHORTFALL_OPEN>CLOSED', 'SURPLUS_HELD>CLOSED') THEN
    allowed := ARRAY['closedAt'];
  ELSIF step IN ('RECOVERED>WITHDRAWN', 'VALUED>WITHDRAWN', 'VALUATION_NOTICE_ISSUED>WITHDRAWN', 'LISTED>WITHDRAWN') THEN
    allowed := ARRAY['withdrawnReason', 'closedAt'];
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status', 'updatedAt'));
  IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A recovery''s figures, payment, notices and freeze dates are write-once: %s may change only %s', step, array_to_string(allowed, ', '));
  END IF;
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  -- The route rules of the matrix: NCA recoveries issue notices, NON_NCA ones do not.
  IF step IN ('VALUED>VALUATION_NOTICE_ISSUED', 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED') AND NOT nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an NCA recovery issues a valuation or final notice';
  END IF;
  IF step = 'VALUED>LISTED' AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery is listed only after its valuation notice';
  END IF;
  IF step IN ('PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD', 'PROCEEDS_APPLIED>CLOSED') AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery gives its final notice before the shortfall or surplus is opened';
  END IF;

  IF step = 'RECOVERED>VALUED' THEN
    IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is valued by a valuation of its own asset';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."valuationId" = NEW."valuationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery reuses its surrender''s valuation';
    END IF;
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId"
          AND s."status" >= 'VALUATION_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s valuation notice';
      END IF;
    ELSIF NEW."valuationNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 valuation notice is stored with its digest';
    END IF;
  ELSIF step = 'LISTED>SOLD' THEN
    IF NOT EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is sold by a completed remarketing sale';
    END IF;
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS NULL OR NEW."chargesFrozenFrom" < NEW."recoveredOn" OR NEW."chargesFrozenFrom" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId";
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed";
      IF receipt_total IS DISTINCT FROM expected_receipt THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan';
      END IF;
    ELSIF NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No receipt is credited when the net proceeds or the settlement is nil';
    END IF;
    -- UNTESTED: the charge freeze (NCA s127(8); a NON_NCA demand period) is for the lender's legal team to sign off.
    IF nca THEN
      IF NEW."chargesFrozenUntil" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA freeze ends 10 business days after the final notice, set with it';
      END IF;
    ELSE
      SELECT c."nonNcaDemandPeriodDays" INTO config FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
      IF NEW."chargesFrozenUntil" IS DISTINCT FROM NEW."chargesFrozenFrom" + COALESCE(config."nonNcaDemandPeriodDays", 10) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA freeze runs the lender''s demand period from the proceeds';
      END IF;
    END IF;
  -- UNTESTED: s127(8) read as 10 SA business days after the final notice.
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    IF NEW."finalNoticeIssuedOn" IS NULL OR NEW."finalNoticeIssuedOn" > today OR NEW."finalNoticeIssuedOn" < OLD."chargesFrozenFrom" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final notice is dated from the proceeds to today';
    END IF;
    IF NEW."chargesFrozenUntil" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Charges stay frozen until 10 business days after the final notice';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'FINAL_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s final notice';
      END IF;
    ELSIF NEW."finalNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 final notice is stored with its digest';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SHORTFALL_OPEN') THEN
    IF NEW."shortfallCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."shortfallCents" <> 0 OR NEW."surplusCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus closes when its refund is released';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' THEN
    IF length(btrim(COALESCE(NEW."withdrawnReason", ''))) < 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A withdrawal records its reason (at least 10 characters)';
    END IF;
    IF EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery with a completed sale cannot be withdrawn';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Recovery_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Recovery"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecovery"();
CREATE TRIGGER "Recovery_no_truncate" BEFORE TRUNCATE ON "Recovery"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRecovery"();

-- ---------------------------------------------------------------------------
-- The asset's status follows its recovery: RECOVERED on a recovery, back to
-- none when it is withdrawn, SOLD_IN_REMARKETING when a sale completes. The
-- database writes it (the code does not), and guardAssetLessorStatus refuses
-- every other way to reach these values.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardAssetLessorStatus"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."lessorStatus" IS NOT NULL AND NEW."lessorStatus" IS NULL AND NOT (
      OLD."lessorStatus" = 'RECOVERED'
      AND EXISTS (SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'WITHDRAWN')
      AND NOT EXISTS (SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" NOT IN ('CLOSED', 'WITHDRAWN'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A leased asset''s lessor status is not cleared';
  END IF;
  IF OLD."lessorStatus" = 'SOLD_TO_LESSEE' AND NEW."lessorStatus" IS DISTINCT FROM OLD."lessorStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset sold to the lessee is not the lessor''s any more';
  END IF;
  IF NEW."lessorStatus" = 'SOLD_TO_LESSEE' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND NOT EXISTS (
      SELECT 1 FROM "LeaseEndOfTerm" e JOIN "Loan" l ON l."id" = e."loanId" AND l."tenantId" = e."tenantId"
      WHERE l."assetId" = NEW."id" AND l."tenantId" = NEW."tenantId" AND e."outcome" = 'PURCHASE' AND e."status" = 'COMPLETED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset is sold to the lessee by a completed purchase';
  END IF;
  IF OLD."lessorStatus" = 'SOLD_IN_REMARKETING' AND NEW."lessorStatus" IS DISTINCT FROM OLD."lessorStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset sold in remarketing is not the lender''s any more';
  END IF;
  IF OLD."lessorStatus" = 'RECOVERED' AND NEW."lessorStatus" IN ('RETURNED_TO_STOCK', 'SOLD_TO_LESSEE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovered asset leaves the lender only through its recovery';
  END IF;
  IF NEW."lessorStatus" = 'RECOVERED' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND (OLD."lessorStatus" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" NOT IN ('CLOSED', 'WITHDRAWN'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset is recovered by its open recovery';
  END IF;
  IF NEW."lessorStatus" = 'SOLD_IN_REMARKETING' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND NOT (OLD."lessorStatus" = 'RECOVERED' AND EXISTS (
      SELECT 1 FROM "RemarketingSale" s JOIN "Recovery" r ON r."id" = s."recoveryId" AND r."tenantId" = s."tenantId"
      WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovered asset is sold in remarketing by a completed sale';
  END IF;
  RETURN NEW;
END;
$function$;

-- A deal never names a recovered or remarketed asset either (the released-asset rule stays as it was).
CREATE OR REPLACE FUNCTION public."guardAssetDealUnreleasedAsset"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  released TIMESTAMP(3);
  lessor_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."assetId" IS NOT DISTINCT FROM OLD."assetId" AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
    RETURN NEW;
  END IF;
  SELECT a."releasedAt", a."lessorStatus"::TEXT INTO released, lessor_status FROM "FinancedAsset" a
  WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId"
  FOR SHARE;
  IF released IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset has been released and cannot be financed again';
  END IF;
  IF lessor_status IN ('RECOVERED', 'SOLD_IN_REMARKETING') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovered asset cannot be financed again';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."syncRecoveryAssetStatus"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "FinancedAsset" SET "lessorStatus" = 'RECOVERED', "lessorStatusAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."assetId" AND "tenantId" = NEW."tenantId" AND "lessorStatus" IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset is already recovered, returned to stock or sold';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' AND OLD."status" <> 'WITHDRAWN' THEN
    UPDATE "FinancedAsset" SET "lessorStatus" = NULL, "lessorStatusAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."assetId" AND "tenantId" = NEW."tenantId" AND "lessorStatus" = 'RECOVERED';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE TRIGGER "Recovery_sync_asset_status" AFTER INSERT OR UPDATE OF "status" ON "Recovery"
  FOR EACH ROW EXECUTE FUNCTION public."syncRecoveryAssetStatus"();

CREATE OR REPLACE FUNCTION public."syncSaleAssetStatus"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD."status" <> 'COMPLETED') THEN
    UPDATE "FinancedAsset" a SET "lessorStatus" = 'SOLD_IN_REMARKETING', "lessorStatusAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      FROM "Recovery" r
      WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" AND a."id" = r."assetId" AND a."tenantId" = r."tenantId" AND a."lessorStatus" = 'RECOVERED';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale completes on a recovered asset';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Remarketing sale
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "RemarketingSale_one_completed_per_recovery" ON "RemarketingSale"("tenantId", "recoveryId") WHERE "status" = 'COMPLETED';

ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_amounts" CHECK ("priceInclVatCents" > 0 AND "highestValuationCents" >= 0);
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_buyer" CHECK (length(btrim("buyerName")) > 0 AND length(btrim("buyerIdentifier")) > 0 AND length(btrim("buyerAddress")) > 0);
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_screening_shape" CHECK (jsonb_typeof("screeningResult") = 'object');
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_below_reason" CHECK (NOT "belowValuation" OR length(btrim(COALESCE("belowValuationReason", ''))) >= 10);
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_approval_pair" CHECK (("approvedById" IS NULL) = ("approvedAt" IS NULL));
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_completed_columns" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL) AND ("status" <> 'COMPLETED' OR "taxInvoiceId" IS NOT NULL));
-- UNTESTED: the lender's policy on sales below valuation and to related parties.
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_second_approver" CHECK (
  "status" <> 'COMPLETED' OR NOT ("belowValuation" OR "relatedPartyMatch") OR ("approvedById" IS NOT NULL AND "approvedById" <> "createdById"));

CREATE OR REPLACE FUNCTION public."guardRemarketingSale"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  loan_row RECORD;
  max_age INTEGER;
  highest INTEGER;
  buyer_key TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A remarketing sale is never deleted: cancel it';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'PENDING_APPROVAL' THEN
      IF NOT (OLD."status" = 'COMPLETED' AND OLD."proceedsPaymentId" IS NULL AND NEW."proceedsPaymentId" IS NOT NULL
          AND (to_jsonb(NEW) - 'proceedsPaymentId') = (to_jsonb(OLD) - 'proceedsPaymentId')) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed or cancelled sale is immutable (its proceeds payment is set once)';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'approvedAt', 'completedAt', 'taxInvoiceId'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'approvedAt', 'completedAt', 'taxInvoiceId']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pending sale changes only its approval, completion and invoice';
    END IF;
    IF NEW."status" <> 'COMPLETED' THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."status" <> 'PENDING_APPROVAL' OR num_nonnulls(NEW."approvedById", NEW."approvedAt", NEW."completedAt", NEW."taxInvoiceId", NEW."proceedsPaymentId") > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale opens PENDING_APPROVAL, unapproved and uninvoiced';
  END IF;

  SELECT r."status"::TEXT AS status, r."assetId", r."loanId" INTO rec
    FROM "Recovery" r WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  IF NOT FOUND OR rec.status <> 'LISTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale is recorded and completed on a listed recovery';
  END IF;
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId"
      AND v."source" <> 'INTERNAL' AND v."valuedOn" >= today - max_age) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A sale relies on an independent (not internal) valuation of this asset dated within %s days', max_age);
  END IF;
  SELECT COALESCE(max(v."amountCents"), 0) INTO highest FROM "AssetValuation" v
    WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" <> 'INTERNAL' AND v."valuedOn" >= today - max_age;
  IF NEW."belowValuation" IS DISTINCT FROM (NEW."priceInclVatCents" < highest) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'belowValuation is whether the price is under the highest current independent valuation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW."highestValuationCents" <> highest THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The highest valuation recorded is the highest current independent valuation';
  END IF;
  -- The database cannot see hidden relationships, but a buyer who carries the borrower's, or a
  -- related client's, ID or registration number is a related party whatever the screening says.
  SELECT l."clientId", l."entityId" INTO loan_row FROM "Loan" l WHERE l."id" = rec."loanId" AND l."tenantId" = NEW."tenantId";
  buyer_key := public."recoveryIdentifierKey"(NEW."buyerIdentifier");
  IF buyer_key <> '' AND (
      EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = loan_row."clientId" AND c."tenantId" = NEW."tenantId" AND public."recoveryIdentifierKey"(c."idNumber") = buyer_key)
      OR EXISTS (SELECT 1 FROM "BusinessEntity" b WHERE b."id" = loan_row."entityId" AND b."tenantId" = NEW."tenantId" AND public."recoveryIdentifierKey"(b."registrationNumber") = buyer_key)
      OR EXISTS (SELECT 1 FROM "EntityRelationship" er JOIN "Client" c ON c."id" = er."clientId" AND c."tenantId" = er."tenantId"
        WHERE er."entityId" = loan_row."entityId" AND er."tenantId" = NEW."tenantId" AND public."recoveryIdentifierKey"(c."idNumber") = buyer_key)) THEN
    NEW."relatedPartyMatch" := true;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "RemarketingSale_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RemarketingSale"
  FOR EACH ROW EXECUTE FUNCTION public."guardRemarketingSale"();
CREATE TRIGGER "RemarketingSale_no_truncate" BEFORE TRUNCATE ON "RemarketingSale"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRemarketingSale"();
CREATE TRIGGER "RemarketingSale_sync_asset_status" AFTER INSERT OR UPDATE OF "status" ON "RemarketingSale"
  FOR EACH ROW EXECUTE FUNCTION public."syncSaleAssetStatus"();

-- ---------------------------------------------------------------------------
-- Recovery cost (immutable)
-- ---------------------------------------------------------------------------
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_amounts" CHECK ("netCents" >= 0 AND "vatCents" >= 0 AND "grossCents" = "netCents" + "vatCents" AND "grossCents" > 0);
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_invoice_ref" CHECK (length(btrim("supplierInvoiceRef")) > 0);
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_approver_differs" CHECK (length(btrim("recordedById")) > 0 AND "approvedById" <> "recordedById");

CREATE OR REPLACE FUNCTION public."guardRecoveryCost"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  config RECORD;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery cost is immutable';
  END IF;
  SELECT r."status"::TEXT AS status, r."route"::TEXT AS route, r."loanId" INTO rec
    FROM "Recovery" r WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  IF NOT FOUND OR rec.status NOT IN ('RECOVERED', 'VALUED', 'VALUATION_NOTICE_ISSUED', 'LISTED', 'SOLD') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Costs are recorded before the sale proceeds are applied';
  END IF;
  IF NEW."incurredOn" > today THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cost is not dated in the future';
  END IF;
  IF NEW."legalStepId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "LegalMatterStep" s JOIN "LegalMatter" m ON m."id" = s."matterId" AND m."tenantId" = s."tenantId"
      WHERE s."id" = NEW."legalStepId" AND s."tenantId" = NEW."tenantId" AND m."loanId" = rec."loanId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cost''s legal step belongs to this loan''s legal matter';
  END IF;
  SELECT c."recoveryNcaDeductibleCostTypes" AS nca_types, c."recoveryNonNcaChargeableCostTypes" AS non_nca_types INTO config
    FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
  IF rec.route LIKE 'NCA\_%' THEN
    -- UNTESTED: what an NCA lender may recover from the debtor is for its legal team to sign off.
    IF NEW."treatment" = 'DEDUCT_FROM_PROCEEDS' AND NOT (NEW."type" = ANY (COALESCE(config.nca_types, ARRAY[]::"RecoveryCostType"[]))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery deducts only the lender''s allowed cost types from the proceeds';
    END IF;
    IF NEW."treatment" = 'CHARGE_TO_ACCOUNT' AND NEW."type" <> 'LEGAL_TAXED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only taxed legal costs are charged to an NCA account';
    END IF;
    IF NEW."type" = 'LEGAL_TAXED' AND NOT EXISTS (
        SELECT 1 FROM "LegalMatterStep" s WHERE s."id" = NEW."legalStepId" AND s."tenantId" = NEW."tenantId" AND s."kind" IN ('JUDGMENT', 'SETTLED')
          AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Taxed legal costs name the judgment or settlement step of the legal matter';
    END IF;
  ELSIF NOT (NEW."type" = ANY (COALESCE(config.non_nca_types, ARRAY[]::"RecoveryCostType"[]))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA recovery records only the lender''s allowed cost types';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "RecoveryCost_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryCost"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryCost"();
CREATE TRIGGER "RecoveryCost_no_truncate" BEFORE TRUNCATE ON "RecoveryCost"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRecoveryCost"();

-- ---------------------------------------------------------------------------
-- Recovery VAT event (immutable). UNTESTED: tax memo (lib/asset-finance/recovery-vat.ts).
-- ---------------------------------------------------------------------------
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_amounts" CHECK (
  "deemedSupplyValueCents" >= 0 AND "inputTaxClaimCents" >= 0 AND "outputTaxCents" >= 0
  AND "vatRateTenThousandths" BETWEEN 1 AND 5000 AND length(btrim("basis")) >= 3 AND length(btrim("recordedById")) > 0);
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_vendor_number" CHECK ("debtorVatVendor" OR "debtorVatNumber" IS NULL);
-- A lessor resale is no deemed supply: nothing deemed, no input tax claimed.
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_resale_no_deemed_supply" CHECK ("kind" <> 'LESSOR_RESALE' OR ("deemedSupplyValueCents" = 0 AND "inputTaxClaimCents" = 0));
-- Input tax = value x rate / (10000 + rate), half-up (s8(10), s10(10), s16(3)).
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_input_tax_formula" CHECK ("kind" <> 'REPOSSESSION_DEEMED_SUPPLY'
  OR "inputTaxClaimCents" = (2::BIGINT * "deemedSupplyValueCents" * "vatRateTenThousandths" + (10000 + "vatRateTenThousandths")) / (2 * (10000 + "vatRateTenThousandths")));

CREATE OR REPLACE FUNCTION public."guardRecoveryVatEvent"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  contract TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery VAT event is immutable';
  END IF;
  SELECT r."status"::TEXT AS status, l."contractType"::TEXT AS contract_type INTO rec
    FROM "Recovery" r JOIN "Loan" l ON l."id" = r."loanId" AND l."tenantId" = r."tenantId"
    WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" FOR SHARE OF r;
  IF NOT FOUND OR rec.status = 'WITHDRAWN' OR rec.contract_type IS DISTINCT FROM NEW."dealContractType"::TEXT THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A VAT event belongs to a live recovery and records its loan''s contract type';
  END IF;
  IF (NEW."kind" = 'REPOSSESSION_DEEMED_SUPPLY') <> (rec.contract_type IN ('INSTALMENT_SALE', 'FINANCE_LEASE')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deemed supply belongs to an instalment sale or finance lease, a lessor resale to an operating or maintenance lease';
  END IF;
  IF NEW."eventDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A VAT event is not dated in the future';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "RecoveryVatEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryVatEvent"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryVatEvent"();
CREATE TRIGGER "RecoveryVatEvent_no_truncate" BEFORE TRUNCATE ON "RecoveryVatEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRecoveryVatEvent"();

-- ---------------------------------------------------------------------------
-- Recovery refund (the surplus payout): two people, the bank details evidenced
-- ---------------------------------------------------------------------------
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_shape" CHECK ("amountCents" > 0 AND length(btrim("accountHolder")) > 0 AND length(btrim("bankName")) > 0
  AND length(btrim("branchCode")) > 0 AND length(btrim("accountNumber")) > 0 AND length(btrim("bankVerifiedById")) > 0 AND length(btrim("createdById")) > 0);
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_approver_differs" CHECK ("approvedById" IS NULL OR "approvedById" <> "createdById");
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_status_columns" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "approvedById" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'RELEASED' AND "approvedById" IS NOT NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION public."guardRecoveryRefund"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery refund is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT r."status"::TEXT AS status, r."surplusCents" INTO rec
      FROM "Recovery" r WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
    IF NOT FOUND OR rec.status <> 'SURPLUS_HELD' OR NEW."amountCents" IS DISTINCT FROM rec."surplusCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund is the whole surplus of a recovery that holds one';
    END IF;
    IF NEW."status" <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund opens PENDING_APPROVAL';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'releasedById', 'releasedAt'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'releasedById', 'releasedAt']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund''s amount, account and bank verification are fixed';
  END IF;
  IF (OLD."status", NEW."status") NOT IN (('PENDING_APPROVAL', 'APPROVED'), ('APPROVED', 'RELEASED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund is approved, then released, once each';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "RecoveryRefund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryRefund"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryRefund"();
CREATE TRIGGER "RecoveryRefund_no_truncate" BEFORE TRUNCATE ON "RecoveryRefund"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRecoveryRefund"();

-- ---------------------------------------------------------------------------
-- Row-level security: the policy of 20261015130000_tenant_rls_new_scoped_models.
-- ---------------------------------------------------------------------------
ALTER TABLE "LegalMatter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalMatter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LegalMatter" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "LegalMatterStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalMatterStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LegalMatterStep" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "Recovery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recovery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Recovery" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RecoveryCost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryCost" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RecoveryCost" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RemarketingSale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RemarketingSale" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RemarketingSale" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RecoveryVatEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryVatEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RecoveryVatEvent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "RecoveryRefund" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecoveryRefund" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "RecoveryRefund" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

