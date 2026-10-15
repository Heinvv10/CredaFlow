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
CREATE TYPE "RecoveryCostStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

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

-- AlterEnum
ALTER TYPE "LoanChargeType" ADD VALUE 'RECOVERY_COST';

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
    "previousLessorStatus" "AssetLessorStatus",
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
    "unrecoverableCostsCents" INTEGER,
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
    "status" "RecoveryCostStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
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
    "selfValued" BOOLEAN NOT NULL DEFAULT false,
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
ALTER TABLE "LegalMatter" ADD CONSTRAINT "LegalMatter_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
ALTER TABLE "LegalMatterStep" ADD CONSTRAINT "LegalMatterStep_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_legalStepId_fkey" FOREIGN KEY ("tenantId", "legalStepId") REFERENCES "LegalMatterStep"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RemarketingSale" ADD CONSTRAINT "RemarketingSale_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_recoveryId_fkey" FOREIGN KEY ("tenantId", "recoveryId") REFERENCES "Recovery"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_bankVerificationDocumentId_fkey" FOREIGN KEY ("tenantId", "bankVerificationDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_bankVerifiedById_fkey" FOREIGN KEY ("tenantId", "bankVerifiedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_tenantId_releasedById_fkey" FOREIGN KEY ("tenantId", "releasedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

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

-- Text with every Unicode decimal digit (any script) written as an ASCII digit: compatibility forms
-- first (NFKC: fullwidth, mathematical and superscript digits), then the other scripts' digits by
-- block (Arabic-Indic U+0660, Extended Arabic-Indic U+06F0, Devanagari U+0966, Thai U+0E50, ...). The list of blocks is
-- lib/asset-finance/recovery-digit-blocks.ts DIGIT_BLOCK_STARTS, the same for the TypeScript screening (every block of Unicode 17).
CREATE OR REPLACE FUNCTION public."recoveryAsciiDigits"(value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $function$
  SELECT translate(normalize(COALESCE(value, ''), NFKC),
    (SELECT string_agg(chr(b + d), '' ORDER BY b, d) FROM unnest(ARRAY[1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720, 68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016, 72688, 72784, 73040, 73120, 73184, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782, 120792, 120802, 120812, 120822, 123200, 123632, 124144, 124401, 125264, 130032]) AS b, generate_series(0, 9) AS d),
    (SELECT string_agg(d::TEXT, '' ORDER BY b, d) FROM unnest(ARRAY[1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872, 4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720, 68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016, 72688, 72784, 73040, 73120, 73184, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782, 120792, 120802, 120812, 120822, 123200, 123632, 124144, 124401, 125264, 130032]) AS b, generate_series(0, 9) AS d));
$function$;

-- An identifier as the screening compares it (lib/asset-finance/recovery-screening.ts canonicalIdentifier,
-- the same rules):
--   0. a CIPC registration number written with separators (an optional label or CK prefix, year, a number of 1 to 6
--      digits, a suffix of 1 or 2 digits, an optional trailing label) is read segment by segment as written:
--      year + the number zero-padded to 6 + the suffix as a number ("2098/12345/05" is "2098/012345/05");
--   1. NFKC, every Unicode decimal digit as ASCII (recoveryAsciiDigits);
--   2. only letters and digits, upper case;
--   3. letters at the start or end of an otherwise all-digit key of 6 or more digits are dropped (a label such as "ID" or "Reg");
--   4. a run of 11 or 12 digits (optionally CK first), ^(CK)?YYYY NNNNNN SS?$, is year + number + the suffix as a number
--      ("CK2098100005 05" is "2098/100005/5", "/07" differs, a missing suffix does not match).
-- UNTESTED: the forms of registration number are for the lender's compliance team to confirm.
CREATE OR REPLACE FUNCTION public."recoveryIdentifierPlainKey"(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  k TEXT := upper(regexp_replace(public."recoveryAsciiDigits"(value), '[^A-Za-z0-9]', '', 'g'));
  bare TEXT;
  registration TEXT[];
BEGIN
  bare := regexp_replace(regexp_replace(k, '^[A-Z]{1,8}(?=[0-9])', ''), '(?<=[0-9])[A-Z]{1,8}$', '');
  IF bare ~ '^[0-9]{6,}$' THEN
    k := bare;
  END IF;
  registration := regexp_match(k, '^(?:CK)?([0-9]{4})([0-9]{6})([0-9]{1,2})$');
  IF registration IS NOT NULL THEN
    RETURN registration[1] || registration[2] || (registration[3]::INTEGER)::TEXT;
  END IF;
  RETURN k;
END;
$function$;

CREATE OR REPLACE FUNCTION public."recoveryIdentifierKey"(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  registration TEXT[];
BEGIN
  registration := regexp_match(translate(public."recoveryAsciiDigits"(value), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
    '^[^0-9A-Z]*(?:[A-Z]{1,8}[^0-9A-Z]*)?([0-9]{4})[^0-9A-Z]+([0-9]{1,6})[^0-9A-Z]+([0-9]{1,2})(?:[^0-9A-Z]*[A-Z]{1,8})?[^0-9A-Z]*$');
  IF registration IS NOT NULL THEN
    RETURN registration[1] || lpad(registration[2], 6, '0') || (registration[3]::INTEGER)::TEXT;
  END IF;
  RETURN public."recoveryIdentifierPlainKey"(value);
END;
$function$;

-- Both readings of an identifier, each non-empty one (the screening's candidateKeys): the key and the plain key differ
-- when the separator reading parses, and a known identifier is matched on either, so a parse that goes one way
-- never hides the other.
CREATE OR REPLACE FUNCTION public."recoveryIdentifierCandidates"(value TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $function$
  SELECT ARRAY(SELECT k FROM unnest(ARRAY[public."recoveryIdentifierKey"(value), public."recoveryIdentifierPlainKey"(value)]) AS k WHERE k <> '' GROUP BY k ORDER BY k COLLATE "C");
$function$;

-- Everything a buyer's identifier field may hold, as keys to compare a known identifier against
-- (lib/asset-finance/recovery-screening.ts identifierKeys, the same set, sorted by byte order): its
-- canonical key; each digit run and all the digits together (label letters removed; the letters O, l, I
-- read as 0, 1, 1 inside tokens made only of digits and those letters); every 13 digits of those (an SA ID
-- inside a longer field: two IDs, an appended digit, a "27" prefix, a label in the middle); every 11 or 12
-- digits as a registration number; and each registration number written with separators anywhere in it.
-- A known identifier matches when its canonical key is one of them.
CREATE OR REPLACE FUNCTION public."recoveryIdentifierKeys"(identifier TEXT)
RETURNS TEXT[] LANGUAGE plpgsql IMMUTABLE AS $function$
DECLARE
  folded TEXT := translate(public."recoveryAsciiDigits"(identifier), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  fixed TEXT := '';
  piece TEXT[];
  sources TEXT[];
  src TEXT;
  window_ TEXT;
  keys TEXT[] := ARRAY[]::TEXT[];
  written TEXT[];
  at INTEGER;
  len INTEGER;
BEGIN
  keys := keys || public."recoveryIdentifierCandidates"(identifier);
  FOR piece IN SELECT m FROM regexp_matches(folded, '([0-9A-Z]+)|([^0-9A-Z]+)', 'g') AS m LOOP
    IF piece[1] IS NOT NULL AND piece[1] ~ '^[0-9OLI]+$' AND piece[1] ~ '[0-9]' THEN
      fixed := fixed || translate(piece[1], 'OLI', '011');
    ELSE
      fixed := fixed || COALESCE(piece[1], piece[2]);
    END IF;
  END LOOP;
  sources := ARRAY(SELECT m[1] FROM regexp_matches(fixed, '([0-9]+)', 'g') AS m) || regexp_replace(fixed, '[^0-9]', '', 'g');
  FOREACH src IN ARRAY sources LOOP
    IF src <> '' THEN
      keys := keys || src;
      FOR at IN 1..length(src) - 12 LOOP
        keys := keys || substr(src, at, 13);
      END LOOP;
      FOR len IN 11..12 LOOP
        FOR at IN 1..length(src) - len + 1 LOOP
          window_ := substr(src, at, len);
          keys := keys || (substr(window_, 1, 4) || substr(window_, 5, 6) || (substr(window_, 11)::INTEGER)::TEXT);
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;
  FOR written IN SELECT m FROM regexp_matches(fixed, '([0-9]{4})[^0-9A-Z]+([0-9]{1,6})[^0-9A-Z]+([0-9]{1,2})', 'g') AS m LOOP
    keys := keys || (written[1] || lpad(written[2], 6, '0') || (written[3]::INTEGER)::TEXT);
  END LOOP;
  RETURN ARRAY(SELECT k FROM unnest(keys) AS k GROUP BY k ORDER BY k COLLATE "C");
END;
$function$;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_recovery_settings" CHECK ("nonNcaDemandPeriodDays" BETWEEN 1 AND 90);
-- UNTESTED: contractual and untaxed legal costs and unspecified costs are never deducted from an NCA recovery's proceeds, whatever the lender configures.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_recovery_nca_deductible" CHECK (
  NOT ("recoveryNcaDeductibleCostTypes" && ARRAY['LEGAL_TAXED', 'LEGAL_CONTRACTUAL', 'OTHER']::"RecoveryCostType"[]));

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
-- A section 129 notice record backs one step (a correcting step may name it again).
CREATE UNIQUE INDEX "LegalMatterStep_section129_record_once" ON "LegalMatterStep"("tenantId", "section129RecordId")
  WHERE "section129RecordId" IS NOT NULL AND "correctsStepId" IS NULL;

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
  SELECT m."loanId", m."status"::TEXT AS status, m."createdAt" INTO matter
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
        AND c."referenceId" = matter."loanId" AND c."type" = 'SECTION_129_NOTICE' AND c."status" = 'COMPLETED'
        -- the notice was sent (completed) on or before the step's date, in SAST
        AND (c."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= NEW."stepDate"
        -- UNTESTED: a notice is for the current default; read here as completed within a year before the matter opened
        AND c."completedAt" >= matter."createdAt" - INTERVAL '365 days') THEN
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
-- The part of the charged costs the loan's ledger could not carry (the NCA in-duplum headroom, or a loan the proceeds already
-- settled): set once, after the proceeds, and never more than the costs charged or the shortfall that includes them.
ALTER TABLE "Recovery" ADD CONSTRAINT "Recovery_unrecoverable_costs" CHECK ("unrecoverableCostsCents" IS NULL OR (
  "chargedCostsCents" IS NOT NULL AND "shortfallCents" IS NOT NULL
  AND "unrecoverableCostsCents" >= 0 AND "unrecoverableCostsCents" <= "chargedCostsCents" AND "unrecoverableCostsCents" <= "shortfallCents"));
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
  sale_price INTEGER;
  sale_day DATE;
  live_status TEXT;
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
  IF NEW."meterReadingId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."meterReadingId" IS DISTINCT FROM OLD."meterReadingId") AND NOT EXISTS (
      SELECT 1 FROM "AssetMeterReading" r WHERE r."id" = NEW."meterReadingId" AND r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s meter reading is its own asset''s';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    -- Locks, in this order, on the rows the checks below read, so a concurrent booking, completion or credit cannot slip
    -- between the check and the commit (READ COMMITTED): the loan (FOR SHARE: its status cannot change under us), the
    -- asset (FOR UPDATE: it conflicts with the key-share lock a Loan insert takes through its foreign key, and with the
    -- Loan guard's share lock) and the surrender (FOR UPDATE: a credit of it waits, then sees this recovery).
    SELECT l."status"::TEXT INTO live_status FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;
    IF live_status NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened on an active, defaulted or pending write-off loan';
    END IF;
    -- the asset's lessor status before the recovery: none, or the stock a lease returned (a re-leased asset is recovered too)
    SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
    -- the loan that holds the asset now: an asset a lease returned and a new lease took is the new lease's
    IF EXISTS (SELECT 1 FROM "Loan" o WHERE o."tenantId" = NEW."tenantId" AND o."assetId" = NEW."assetId" AND o."id" <> NEW."loanId"
        AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'WRITTEN_OFF')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened by the loan that holds the asset now';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NEW."surrenderRequestId" IS NOT NULL THEN
      PERFORM 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows a surrender that has not yet been credited or finally noticed';
      END IF;
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."status" <> 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery stands on an open legal matter';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT', NEW."recoveredOn") THEN
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
    -- once the proceeds are applied, the costs the ledger could not carry are recorded: NULL to a value, in this status only
    IF OLD."status" = 'PROCEEDS_APPLIED' AND OLD."unrecoverableCostsCents" IS NULL THEN
      allowed := allowed || ARRAY['unrecoverableCostsCents'];
    END IF;
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil', 'unrecoverableCostsCents'];
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
    -- Charges freeze from the day the proceeds are applied: the caller does not choose the date.
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT s."priceInclVatCents", (s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO sale_price, sale_day
      FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED';
    IF NEW."settlementDueCents" IS NOT NULL AND NEW."grossProceedsCents" IS DISTINCT FROM sale_price THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The gross proceeds are the completed sale''s price';
    END IF;
    IF EXISTS (SELECT 1 FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'PENDING') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied once every cost is decided';
    END IF;
    -- only approved costs are deducted or charged; a rejected one is neither
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed"
          -- the receipt of this recovery's proceeds (its idempotency key), received on or after the day the sale completed
          AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'
          AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day;
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
    -- the notice states what is owed: not before the costs the ledger could not carry are known
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';
    END IF;
    IF NEW."finalNoticeIssuedOn" IS DISTINCT FROM today THEN
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
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before a shortfall is opened';
    END IF;
    -- what is still owed: the shortfall less the charged costs that could not go on the ledger
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
    -- the debtor's account is settled (the receipt paid it in full) before any surplus is held for refund
    IF loan_row.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held only once the loan is settled';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the recovery closes';
    END IF;
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN
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
      AND EXISTS (SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'WITHDRAWN' AND r."previousLessorStatus" IS NULL)
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
  IF OLD."lessorStatus" = 'RECOVERED' AND NEW."lessorStatus" IN ('RETURNED_TO_STOCK', 'SOLD_TO_LESSEE') AND NOT (
      NEW."lessorStatus" = 'RETURNED_TO_STOCK'
      AND EXISTS (SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'WITHDRAWN' AND r."previousLessorStatus" = 'RETURNED_TO_STOCK')
      AND NOT EXISTS (SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" NOT IN ('CLOSED', 'WITHDRAWN'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovered asset leaves the lender only through its recovery';
  END IF;
  IF NEW."lessorStatus" = 'RECOVERED' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND ((OLD."lessorStatus" IS NOT NULL AND OLD."lessorStatus" <> 'RETURNED_TO_STOCK') OR NOT EXISTS (
      SELECT 1 FROM "Recovery" r WHERE r."assetId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" NOT IN ('CLOSED', 'WITHDRAWN')
        AND r."previousLessorStatus" IS NOT DISTINCT FROM OLD."lessorStatus")) THEN
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
    -- from no status, or from the stock an earlier lease returned (and the asset was re-leased since)
    UPDATE "FinancedAsset" SET "lessorStatus" = 'RECOVERED', "lessorStatusAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = NEW."assetId" AND "tenantId" = NEW."tenantId" AND ("lessorStatus" IS NULL OR "lessorStatus" = 'RETURNED_TO_STOCK')
        AND "lessorStatus" IS NOT DISTINCT FROM NEW."previousLessorStatus";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset is already recovered or sold';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' AND OLD."status" <> 'WITHDRAWN' THEN
    -- withdrawing gives the asset back the status it had: none, or RETURNED_TO_STOCK
    UPDATE "FinancedAsset" SET "lessorStatus" = NEW."previousLessorStatus", "lessorStatusAt" = CASE WHEN NEW."previousLessorStatus" IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
        "updatedAt" = CURRENT_TIMESTAMP
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
  "status" <> 'COMPLETED' OR NOT ("belowValuation" OR "relatedPartyMatch" OR "selfValued") OR ("approvedById" IS NOT NULL AND "approvedById" <> "createdById"));

-- A buyer whose ID or registration number is the borrower's, or a related client's (any role).
CREATE OR REPLACE FUNCTION public."recoveryBuyerRelated"(tenant_id TEXT, for_loan_id TEXT, identifier TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $function$
DECLARE
  loan_row RECORD;
  buyer_keys TEXT[] := public."recoveryIdentifierKeys"(identifier);
BEGIN
  SELECT l."clientId", l."entityId" INTO loan_row FROM "Loan" l WHERE l."id" = for_loan_id AND l."tenantId" = tenant_id;
  RETURN cardinality(buyer_keys) > 0 AND (
      EXISTS (SELECT 1 FROM "Client" c WHERE c."id" = loan_row."clientId" AND c."tenantId" = tenant_id AND public."recoveryIdentifierCandidates"(c."idNumber") && buyer_keys)
      OR EXISTS (SELECT 1 FROM "BusinessEntity" b WHERE b."id" = loan_row."entityId" AND b."tenantId" = tenant_id AND public."recoveryIdentifierCandidates"(b."registrationNumber") && buyer_keys)
      OR EXISTS (SELECT 1 FROM "EntityRelationship" er JOIN "Client" c ON c."id" = er."clientId" AND c."tenantId" = er."tenantId"
        WHERE er."entityId" = loan_row."entityId" AND er."tenantId" = tenant_id AND public."recoveryIdentifierCandidates"(c."idNumber") && buyer_keys));
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRemarketingSale"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  max_age INTEGER;
  highest INTEGER;
  self_valued BOOLEAN;
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
    -- Approval is its own earlier step, written once; the step that completes a sale does not approve it.
    IF OLD."approvedById" IS NOT NULL AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale''s approval is written once';
    END IF;
    IF NEW."status" = 'COMPLETED' AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale is approved before the step that completes it';
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
  -- Nobody sells on a value they set themselves without a second approver: the valuation the sale relies on, or
  -- the highest current independent one (a tie counts if any of the tied was theirs), was recorded by the proposer.
  -- UNTESTED: the lender's valuation-independence policy.
  self_valued := EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."createdById" = NEW."createdById")
    OR EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" <> 'INTERNAL'
      AND v."valuedOn" >= today - max_age AND v."amountCents" = highest AND v."createdById" = NEW."createdById");
  IF TG_OP = 'UPDATE' THEN
    IF NOT NEW."selfValued" AND self_valued THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale on a valuation its proposer recorded needs the sale re-recorded as self-valued';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId" AND i."loanId" IS NULL
        AND i."totalInclVatCents" = NEW."priceInclVatCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale''s tax invoice is for its price, issued to the buyer outside the loan';
    END IF;
    IF NOT NEW."relatedPartyMatch" AND public."recoveryBuyerRelated"(NEW."tenantId", rec."loanId", NEW."buyerIdentifier") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A buyer who is now a related party needs the sale re-recorded';
    END IF;
    RETURN NEW;
  END IF;

  IF self_valued THEN
    NEW."selfValued" := true;
  END IF;
  IF NEW."highestValuationCents" <> highest THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The highest valuation recorded is the highest current independent valuation';
  END IF;
  -- The database cannot see hidden relationships, but a buyer who carries the borrower's, or a
  -- related client's, ID or registration number is a related party whatever the screening says.
  IF public."recoveryBuyerRelated"(NEW."tenantId", rec."loanId", NEW."buyerIdentifier") THEN
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
-- Recorded PENDING; decided once, by someone other than whoever recorded it.
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_approver_differs" CHECK (length(btrim("recordedById")) > 0 AND ("approvedById" IS NULL OR "approvedById" <> "recordedById"));
ALTER TABLE "RecoveryCost" ADD CONSTRAINT "RecoveryCost_status_columns" CHECK (
  ("status" = 'PENDING' AND "approvedById" IS NULL AND "approvedAt" IS NULL)
  OR ("status" IN ('APPROVED', 'REJECTED') AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL));

CREATE OR REPLACE FUNCTION public."guardRecoveryCost"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  config RECORD;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery cost is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- one decision, PENDING to APPROVED or REJECTED, by the approver and the time; nothing else changes
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A decided recovery cost is immutable';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'approvedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'approvedAt']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cost decision changes only its status, approver and time';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'PENDING' OR NEW."approvedById" IS NOT NULL OR NEW."approvedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cost is recorded PENDING, undecided';
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
          -- the judgment or settlement is evidenced by a stored legal document
          AND s."evidenceDocumentId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "LegalMatterStep" c WHERE c."tenantId" = s."tenantId" AND c."correctsStepId" = s."id")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Taxed legal costs name the evidenced judgment or settlement step of the legal matter';
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
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_vendor_number" CHECK ("debtorVatVendor" = ("debtorVatNumber" IS NOT NULL));
-- A lessor resale is no deemed supply: nothing deemed, no input tax claimed.
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_resale_no_deemed_supply" CHECK ("kind" <> 'LESSOR_RESALE' OR ("deemedSupplyValueCents" = 0 AND "inputTaxClaimCents" = 0));
-- Input tax = value x rate / (10000 + rate), half-up (s8(10), s10(10), s16(3)).
ALTER TABLE "RecoveryVatEvent" ADD CONSTRAINT "RecoveryVatEvent_input_tax_formula" CHECK ("kind" <> 'REPOSSESSION_DEEMED_SUPPLY'
  OR "inputTaxClaimCents" = (2::BIGINT * "deemedSupplyValueCents" * "vatRateTenThousandths" + (10000 + "vatRateTenThousandths")) / (2 * (10000 + "vatRateTenThousandths")));

CREATE OR REPLACE FUNCTION public."guardRecoveryVatEvent"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery VAT event is immutable';
  END IF;
  SELECT r."status"::TEXT AS status, r."recoveredOn", l."contractType"::TEXT AS contract_type, a."cashPriceExclVatCents" + a."vatCents" AS asset_price,
      (SELECT s."priceInclVatCents" FROM "RemarketingSale" s WHERE s."recoveryId" = r."id" AND s."tenantId" = r."tenantId" AND s."status" = 'COMPLETED') AS sale_price INTO rec
    FROM "Recovery" r JOIN "Loan" l ON l."id" = r."loanId" AND l."tenantId" = r."tenantId"
      JOIN "FinancedAsset" a ON a."id" = r."assetId" AND a."tenantId" = r."tenantId"
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
  IF NEW."eventDate" < rec."recoveredOn" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A VAT event is not dated before the recovery';
  END IF;
  IF NEW."kind" = 'REPOSSESSION_DEEMED_SUPPLY' AND NEW."deemedSupplyValueCents" > rec.asset_price THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deemed supply is capped at the asset''s cash price including VAT';
  END IF;
  IF NEW."kind" = 'LESSOR_RESALE' THEN
    IF rec.sale_price IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lessor resale is recorded once the sale is complete';
    END IF;
    -- UNTESTED: output tax on the resale price, the tax fraction half-up (VAT Act s7, s64).
    IF NEW."outputTaxCents" IS DISTINCT FROM (2::BIGINT * rec.sale_price * NEW."vatRateTenThousandths" + (10000 + NEW."vatRateTenThousandths")) / (2 * (10000 + NEW."vatRateTenThousandths")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lessor resale''s output tax is the sale price''s tax fraction';
    END IF;
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
-- Three people: whoever creates, whoever approves and whoever releases.
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_releaser_differs" CHECK ("releasedById" IS NULL OR "releasedById" <> "approvedById");
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_releaser_not_creator" CHECK ("releasedById" IS NULL OR "releasedById" <> "createdById");
ALTER TABLE "RecoveryRefund" ADD CONSTRAINT "RecoveryRefund_status_columns" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "approvedById" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'RELEASED' AND "approvedById" IS NOT NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL));

-- A refund is paid out of money that is really there: the loan is settled and the receipt of the sale
-- proceeds (if any was credited) has not been reversed.
CREATE OR REPLACE FUNCTION public."recoveryRefundBacked"(tenant_id TEXT, for_recovery_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (SELECT 1 FROM "Recovery" r
    JOIN "Loan" l ON l."id" = r."loanId" AND l."tenantId" = r."tenantId"
    LEFT JOIN "Payment" p ON p."id" = r."proceedsPaymentId" AND p."tenantId" = r."tenantId"
    WHERE r."id" = for_recovery_id AND r."tenantId" = tenant_id AND l."status" = 'COMPLETED'
      AND (r."proceedsPaymentId" IS NULL OR (p."id" IS NOT NULL AND NOT p."reversed")));
$function$;

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
  ELSE
    IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'releasedById', 'releasedAt'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'releasedById', 'releasedAt']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund''s amount, account and bank verification are fixed';
    END IF;
    IF (OLD."status", NEW."status") NOT IN (('PENDING_APPROVAL', 'APPROVED'), ('APPROVED', 'RELEASED')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund is approved, then released, once each';
    END IF;
    IF OLD."status" = 'APPROVED' AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund is released on the approval it was given';
    END IF;
  END IF;
  -- creating, approving and releasing all need the money to be there
  IF NOT public."recoveryRefundBacked"(NEW."tenantId", NEW."recoveryId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A refund is paid out of a settled loan and an unreversed proceeds receipt';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "RecoveryRefund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecoveryRefund"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryRefund"();
CREATE TRIGGER "RecoveryRefund_no_truncate" BEFORE TRUNCATE ON "RecoveryRefund"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardRecoveryRefund"();

-- ---------------------------------------------------------------------------
-- The receipt of a recovery's sale proceeds is never reversed: the surplus, shortfall and refund rest on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardRecoveryProceedsPayment"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."reversed" AND NOT OLD."reversed" AND (
      EXISTS (SELECT 1 FROM "Recovery" r WHERE r."proceedsPaymentId" = OLD."id" AND r."tenantId" = OLD."tenantId")
      OR EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."proceedsPaymentId" = OLD."id" AND s."tenantId" = OLD."tenantId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s sale-proceeds receipt is not reversed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Payment_recovery_proceeds_kept" BEFORE UPDATE OF "reversed" ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryProceedsPayment"();

-- ---------------------------------------------------------------------------
-- The documents a recovery stands on are not deleted: the evidence of a legal matter step and the bank
-- verification of a surplus refund (the same rule as a deal signer's scan, guardSigningEvidenceDocument).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardRecoveryEvidenceDocument"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL AND (
      EXISTS (SELECT 1 FROM "LegalMatterStep" s WHERE s."evidenceDocumentId" = OLD."id" AND s."tenantId" = OLD."tenantId")
      OR EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."bankVerificationDocumentId" = OLD."id" AND r."tenantId" = OLD."tenantId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document that evidences a legal matter step or a refund''s bank verification cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "EntityDocument_recovery_evidence" BEFORE UPDATE OF "deletedAt" ON "EntityDocument"
  FOR EACH ROW EXECUTE FUNCTION public."guardRecoveryEvidenceDocument"();

-- ---------------------------------------------------------------------------
-- A surrender a recovery links is credited only by that recovery's proceeds step. The standalone path
-- (creditSurrenderProceeds) checks for a linked recovery and then writes; a recovery linked between the two
-- would be credited twice. guardSurrenderRequest is untouched; this is a separate rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardSurrenderRecoveryProceeds"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'PROCEEDS_CREDITED' AND OLD."status" <> 'PROCEEDS_CREDITED' AND EXISTS (
      SELECT 1 FROM "Recovery" r WHERE r."surrenderRequestId" = NEW."id" AND r."tenantId" = NEW."tenantId"
        AND r."proceedsPaymentId" IS DISTINCT FROM NEW."proceedsPaymentId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Sale proceeds for this surrender go through its recovery';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "SurrenderRequest_recovery_proceeds" BEFORE UPDATE OF "status", "proceedsPaymentId" ON "SurrenderRequest"
  FOR EACH ROW EXECUTE FUNCTION public."guardSurrenderRecoveryProceeds"();

-- ---------------------------------------------------------------------------
-- A loan is not booked on a recovered or remarketed asset (the deal guard's rule, at the loan). The asset row is
-- locked FOR SHARE whatever its state, so this and a recovery opening on it (guardRecovery locks the asset FOR UPDATE)
-- serialise: either the recovery waits and then sees this loan, or this waits and sees RECOVERED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardLoanAssetNotRecovered"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  lessor_status TEXT;
BEGIN
  IF NEW."assetId" IS NULL OR (TG_OP = 'UPDATE' AND NEW."assetId" IS NOT DISTINCT FROM OLD."assetId" AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId") THEN
    RETURN NEW;
  END IF;
  SELECT a."lessorStatus"::TEXT INTO lessor_status FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR SHARE;
  IF lessor_status IN ('RECOVERED', 'SOLD_IN_REMARKETING') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovered asset cannot be financed again';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Loan_asset_not_recovered" BEFORE INSERT OR UPDATE OF "tenantId", "assetId" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanAssetNotRecovered"();

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

