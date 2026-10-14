-- CreateEnum
CREATE TYPE "MaintenanceMovementKind" AS ENUM ('CONTRIBUTION', 'CLAIM', 'SETTLEMENT_REFUND', 'SETTLEMENT_BILLED');

-- CreateEnum
CREATE TYPE "MaintenanceClaimStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "MeterReadingSource" AS ENUM ('STAFF', 'PORTAL');

-- CreateEnum
CREATE TYPE "LeaseEndOutcome" AS ENUM ('RETURN', 'EXTEND', 'PURCHASE');

-- CreateEnum
CREATE TYPE "LeaseEndStatus" AS ENUM ('ELECTED', 'EXTENDING', 'INSPECTED', 'INVOICED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "LeaseEndOrigin" AS ENUM ('EXPIRY', 'EARLY_TERMINATION');

-- CreateEnum
CREATE TYPE "AssetLessorStatus" AS ENUM ('RETURNED_TO_STOCK', 'SOLD_TO_LESSEE');

-- CreateEnum
CREATE TYPE "LeaseTerminationStatus" AS ENUM ('QUOTED', 'ACCEPTED');

-- AlterTable
ALTER TABLE "FinancedAsset" ADD COLUMN     "lessorStatus" "AssetLessorStatus",
ADD COLUMN     "lessorStatusAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LeaseRental" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "leasePurchaseValuationMaxAgeDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "leaseTerminationQuoteValidDays" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maintenanceClaimDualApprovalCents" INTEGER NOT NULL DEFAULT 5000000;

-- CreateTable
CREATE TABLE "MaintenanceFund" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "riskModel" "MaintenanceRiskModel" NOT NULL,
    "leaseEndDate" DATE NOT NULL,
    "settledAt" TIMESTAMP(3),
    "settledBalanceCents" INTEGER,
    "settledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceFundMovement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "kind" "MaintenanceMovementKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "leaseRentalId" TEXT,
    "claimId" TEXT,
    "taxInvoiceId" TEXT,
    "occurredOn" DATE NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceFundMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "providerInvoiceDocumentId" TEXT NOT NULL,
    "meterReadingId" TEXT,
    "amountExclVatCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "status" "MaintenanceClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstApprovedById" TEXT,
    "firstApprovedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "paymentReference" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMeterReading" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "loanId" TEXT,
    "readingDate" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "unit" "UsageUnit" NOT NULL,
    "source" "MeterReadingSource" NOT NULL,
    "evidenceDocumentId" TEXT,
    "recordedById" TEXT,
    "recordedByClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetMeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseEndOfTerm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "origin" "LeaseEndOrigin" NOT NULL,
    "outcome" "LeaseEndOutcome" NOT NULL,
    "status" "LeaseEndStatus" NOT NULL DEFAULT 'ELECTED',
    "electedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "electedById" TEXT,
    "electedByClientId" TEXT,
    "extensionNoticeOn" DATE,
    "extensionEndsOn" DATE,
    "inspectedOn" DATE,
    "inspectionCondition" TEXT,
    "inspectedById" TEXT,
    "finalReadingId" TEXT,
    "excessUsageCents" INTEGER,
    "fundSettlementCents" INTEGER,
    "purchasePriceExclVatCents" INTEGER,
    "purchaseValuationId" TEXT,
    "taxInvoiceId" TEXT,
    "scheduleId" TEXT,
    "natisTransferConfirmedAt" TIMESTAMP(3),
    "natisTransferConfirmedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaseEndOfTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseDamageItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endOfTermId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountExclVatCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseDamageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseExpiryNotice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "expiryDate" DATE NOT NULL,
    "queuedOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseExpiryNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaseTerminationQuote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "quotedOn" DATE NOT NULL,
    "terminationDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "cpaCancellation" BOOLEAN NOT NULL,
    "remainingRentals" INTEGER NOT NULL,
    "pvCents" INTEGER NOT NULL,
    "penaltyCents" INTEGER NOT NULL,
    "arrearsCents" INTEGER NOT NULL,
    "invoiceExclVatCents" INTEGER NOT NULL,
    "invoiceVatCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "status" "LeaseTerminationStatus" NOT NULL DEFAULT 'QUOTED',
    "requestedByClientId" TEXT,
    "createdById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "acceptedByClientId" TEXT,
    "taxInvoiceId" TEXT,
    "scheduleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseTerminationQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFund_loanId_key" ON "MaintenanceFund"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFund_tenantId_id_key" ON "MaintenanceFund"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFund_tenantId_loanId_key" ON "MaintenanceFund"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_leaseRentalId_key" ON "MaintenanceFundMovement"("leaseRentalId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_claimId_key" ON "MaintenanceFundMovement"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_taxInvoiceId_key" ON "MaintenanceFundMovement"("taxInvoiceId");

-- CreateIndex
CREATE INDEX "MaintenanceFundMovement_tenantId_fundId_idx" ON "MaintenanceFundMovement"("tenantId", "fundId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_leaseRentalId_key" ON "MaintenanceFundMovement"("tenantId", "leaseRentalId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_claimId_key" ON "MaintenanceFundMovement"("tenantId", "claimId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_taxInvoiceId_key" ON "MaintenanceFundMovement"("tenantId", "taxInvoiceId");

-- CreateIndex
CREATE INDEX "MaintenanceClaim_tenantId_fundId_idx" ON "MaintenanceClaim"("tenantId", "fundId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceClaim_tenantId_id_key" ON "MaintenanceClaim"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AssetMeterReading_tenantId_assetId_unit_readingDate_idx" ON "AssetMeterReading"("tenantId", "assetId", "unit", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeterReading_tenantId_id_key" ON "AssetMeterReading"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_loanId_key" ON "LeaseEndOfTerm"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_finalReadingId_key" ON "LeaseEndOfTerm"("finalReadingId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_taxInvoiceId_key" ON "LeaseEndOfTerm"("taxInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_scheduleId_key" ON "LeaseEndOfTerm"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_tenantId_id_key" ON "LeaseEndOfTerm"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_tenantId_loanId_key" ON "LeaseEndOfTerm"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_tenantId_finalReadingId_key" ON "LeaseEndOfTerm"("tenantId", "finalReadingId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseEndOfTerm_tenantId_taxInvoiceId_key" ON "LeaseEndOfTerm"("tenantId", "taxInvoiceId");

-- CreateIndex
CREATE INDEX "LeaseDamageItem_tenantId_endOfTermId_idx" ON "LeaseDamageItem"("tenantId", "endOfTermId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseExpiryNotice_loanId_key" ON "LeaseExpiryNotice"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseExpiryNotice_tenantId_loanId_key" ON "LeaseExpiryNotice"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseTerminationQuote_taxInvoiceId_key" ON "LeaseTerminationQuote"("taxInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseTerminationQuote_scheduleId_key" ON "LeaseTerminationQuote"("scheduleId");

-- CreateIndex
CREATE INDEX "LeaseTerminationQuote_tenantId_loanId_idx" ON "LeaseTerminationQuote"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseTerminationQuote_tenantId_id_key" ON "LeaseTerminationQuote"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseTerminationQuote_tenantId_taxInvoiceId_key" ON "LeaseTerminationQuote"("tenantId", "taxInvoiceId");

-- AddForeignKey
ALTER TABLE "MaintenanceFund" ADD CONSTRAINT "MaintenanceFund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceFund" ADD CONSTRAINT "MaintenanceFund_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_fundId_fkey" FOREIGN KEY ("tenantId", "fundId") REFERENCES "MaintenanceFund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_leaseRentalId_fkey" FOREIGN KEY ("tenantId", "leaseRentalId") REFERENCES "LeaseRental"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "MaintenanceClaim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_taxInvoiceId_fkey" FOREIGN KEY ("tenantId", "taxInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_tenantId_fundId_fkey" FOREIGN KEY ("tenantId", "fundId") REFERENCES "MaintenanceFund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_tenantId_providerInvoiceDocumentId_fkey" FOREIGN KEY ("tenantId", "providerInvoiceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_tenantId_meterReadingId_fkey" FOREIGN KEY ("tenantId", "meterReadingId") REFERENCES "AssetMeterReading"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_tenantId_finalReadingId_fkey" FOREIGN KEY ("tenantId", "finalReadingId") REFERENCES "AssetMeterReading"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_purchaseValuationId_fkey" FOREIGN KEY ("purchaseValuationId") REFERENCES "AssetValuation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_tenantId_taxInvoiceId_fkey" FOREIGN KEY ("tenantId", "taxInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseDamageItem" ADD CONSTRAINT "LeaseDamageItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseDamageItem" ADD CONSTRAINT "LeaseDamageItem_tenantId_endOfTermId_fkey" FOREIGN KEY ("tenantId", "endOfTermId") REFERENCES "LeaseEndOfTerm"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseExpiryNotice" ADD CONSTRAINT "LeaseExpiryNotice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseExpiryNotice" ADD CONSTRAINT "LeaseExpiryNotice_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_tenantId_taxInvoiceId_fkey" FOREIGN KEY ("tenantId", "taxInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===========================================================================
-- Hand-written: lease servicing (slice 3, C5–C8). Every rule below has a
-- RUN_ASSET_FINANCE_LEASE_IT case (lib/asset-finance/lease-servicing-sql.integration.test.ts).
-- ===========================================================================

-- The charge rows an end-of-term outcome or a termination bills (tenant-safe).
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_tenantId_scheduleId_fkey"
  FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "RepaymentSchedule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_tenantId_scheduleId_fkey"
  FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "RepaymentSchedule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- C5 Maintenance fund, movements and claims
-- ---------------------------------------------------------------------------
-- A fund belongs to a full-maintenance lease loan, with its deal's risk
-- model; it changes only by being settled, once; it is never deleted.
CREATE OR REPLACE FUNCTION public."guardMaintenanceFund"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE deal_model TEXT;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT d."maintenanceRiskModel"::TEXT INTO deal_model FROM "AssetFinanceDeal" d
      JOIN "Loan" l ON l."id" = d."loanId" AND l."tenantId" = d."tenantId"
      WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."contractType" = 'FULL_MAINTENANCE_LEASE';
    IF deal_model IS NULL OR deal_model IS DISTINCT FROM NEW."riskModel"::TEXT OR NEW."settledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund is written unsettled for a full-maintenance lease, with its deal''s risk model';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['settledAt', 'settledBalanceCents', 'settledById'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['settledAt', 'settledBalanceCents', 'settledById'])
     OR OLD."settledAt" IS NOT NULL OR NEW."settledAt" IS NULL OR NEW."settledBalanceCents" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund changes only by being settled, once';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MaintenanceFund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaintenanceFund"
  FOR EACH ROW EXECUTE FUNCTION public."guardMaintenanceFund"();
CREATE TRIGGER "MaintenanceFund_no_truncate" BEFORE TRUNCATE ON "MaintenanceFund"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardMaintenanceFund"();

ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_shape" CHECK (
  "amountCents" > 0
  AND ("kind" = 'CONTRIBUTION') = ("leaseRentalId" IS NOT NULL)
  AND ("kind" = 'CLAIM') = ("claimId" IS NOT NULL)
  AND ("kind" = 'SETTLEMENT_BILLED') = ("taxInvoiceId" IS NOT NULL)
);
-- At most one settlement movement per fund.
CREATE UNIQUE INDEX "MaintenanceFundMovement_one_settlement" ON "MaintenanceFundMovement"("fundId")
  WHERE "kind" IN ('SETTLEMENT_REFUND', 'SETTLEMENT_BILLED');

-- Movements are immutable. A contribution is an invoiced rental's
-- maintenance of the fund's loan; a claim movement is a PAID claim of the
-- fund, for its amount; a settlement only as the fund is settled.
CREATE OR REPLACE FUNCTION public."guardMaintenanceFundMovement"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE ok BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund movement is immutable';
  END IF;
  IF NEW."kind" = 'CONTRIBUTION' THEN
    SELECT EXISTS (SELECT 1 FROM "LeaseRental" r JOIN "MaintenanceFund" f ON f."loanId" = r."loanId" AND f."tenantId" = r."tenantId"
      WHERE r."id" = NEW."leaseRentalId" AND r."tenantId" = NEW."tenantId" AND f."id" = NEW."fundId"
        AND r."taxInvoiceId" IS NOT NULL AND r."maintenanceExclVatCents" = NEW."amountCents") INTO ok;
  ELSIF NEW."kind" = 'CLAIM' THEN
    SELECT EXISTS (SELECT 1 FROM "MaintenanceClaim" c WHERE c."id" = NEW."claimId" AND c."tenantId" = NEW."tenantId"
      AND c."fundId" = NEW."fundId" AND c."status" = 'PAID' AND c."amountExclVatCents" = NEW."amountCents") INTO ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId"
      AND f."riskModel" = 'LESSEE_SETTLED' AND f."settledAt" IS NULL) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A %s movement must be backed by its rental, paid claim or a lessee-settled fund''s settlement', NEW."kind");
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MaintenanceFundMovement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaintenanceFundMovement"
  FOR EACH ROW EXECUTE FUNCTION public."guardMaintenanceFundMovement"();
CREATE TRIGGER "MaintenanceFundMovement_no_truncate" BEFORE TRUNCATE ON "MaintenanceFundMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardMaintenanceFundMovement"();

ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_shape" CHECK (
  "amountExclVatCents" > 0
  AND length(btrim("description")) >= 3
  AND num_nonnulls("firstApprovedById", "firstApprovedAt") IN (0, 2)
  AND ("status" IN ('APPROVED', 'PAID')) = ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
  AND ("status" = 'PAID') = ("paidById" IS NOT NULL AND "paidAt" IS NOT NULL AND length(btrim(COALESCE("paymentReference", ''))) >= 3)
  AND ("status" = 'REJECTED') = ("rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND length(btrim(COALESCE("rejectionReason", ''))) >= 5)
);
-- Four-eyes: no one approves their own claim; two approvers are two people.
ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_four_eyes" CHECK (
  "approvedById" IS DISTINCT FROM "submittedById"
  AND "firstApprovedById" IS DISTINCT FROM "submittedById"
  AND ("firstApprovedById" IS NULL OR "firstApprovedById" IS DISTINCT FROM "approvedById")
);

CREATE OR REPLACE FUNCTION public."guardMaintenanceClaim"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  fund RECORD;
  threshold INTEGER;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT f."leaseEndDate", l."status"::TEXT AS loan_status, d."id" AS deal_id INTO fund
      FROM "MaintenanceFund" f JOIN "Loan" l ON l."id" = f."loanId" AND l."tenantId" = f."tenantId"
      JOIN "AssetFinanceDeal" d ON d."loanId" = l."id" AND d."tenantId" = l."tenantId"
      WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId";
    IF NEW."status" <> 'SUBMITTED' OR NEW."firstApprovedById" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim is submitted unapproved';
    END IF;
    IF fund.loan_status NOT IN ('ACTIVE', 'DEFAULTED') OR today > fund."leaseEndDate" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No maintenance claim after the lease ends';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Supplier" s JOIN "SupplierBankAccount" a ON a."supplierId" = s."id" AND a."tenantId" = s."tenantId"
        WHERE s."id" = NEW."supplierId" AND s."tenantId" = NEW."tenantId" AND s."active" AND a."status" = 'APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim''s provider is an active supplier with an APPROVED bank account';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "EntityDocument" e WHERE e."id" = NEW."providerInvoiceDocumentId" AND e."tenantId" = NEW."tenantId"
        AND e."dealId" = fund.deal_id AND e."deletedAt" IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim''s provider invoice is a live document of its lease';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('PAID', 'REJECTED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A paid or rejected maintenance claim is final';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'firstApprovedById', 'firstApprovedAt', 'approvedById', 'approvedAt', 'rejectedById', 'rejectedAt',
        'rejectionReason', 'paymentReference', 'paidById', 'paidAt'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'firstApprovedById', 'firstApprovedAt', 'approvedById', 'approvedAt', 'rejectedById',
        'rejectedAt', 'rejectionReason', 'paymentReference', 'paidById', 'paidAt']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim''s fund, provider, invoice, amount and description are fixed';
  END IF;
  IF NOT ((OLD."status" = 'SUBMITTED' AND NEW."status" IN ('SUBMITTED', 'APPROVED', 'REJECTED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PAID')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A maintenance claim cannot move from %s to %s', OLD."status", NEW."status");
  END IF;
  IF OLD."firstApprovedById" IS NOT NULL AND NEW."firstApprovedById" IS DISTINCT FROM OLD."firstApprovedById" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A first approval is not changed';
  END IF;
  IF NEW."status" = 'APPROVED' AND OLD."status" = 'SUBMITTED' THEN
    SELECT COALESCE((SELECT c."maintenanceClaimDualApprovalCents" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 0) INTO threshold;
    IF NEW."amountExclVatCents" >= threshold AND NEW."firstApprovedById" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim at or above the threshold needs two approvers';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MaintenanceClaim_guard" BEFORE INSERT OR UPDATE OR DELETE ON "MaintenanceClaim"
  FOR EACH ROW EXECUTE FUNCTION public."guardMaintenanceClaim"();
CREATE TRIGGER "MaintenanceClaim_no_truncate" BEFORE TRUNCATE ON "MaintenanceClaim"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardMaintenanceClaim"();

-- At commit, a PAID claim has its CLAIM movement.
CREATE OR REPLACE FUNCTION public."checkPaidClaimMovement"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'PAID' AND NOT EXISTS (SELECT 1 FROM "MaintenanceFundMovement" m WHERE m."claimId" = NEW."id" AND m."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A paid maintenance claim is drawn from its fund (a CLAIM movement)';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "MaintenanceClaim_paid_has_movement" AFTER UPDATE OF "status" ON "MaintenanceClaim"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkPaidClaimMovement"();

-- ---------------------------------------------------------------------------
-- C6 Meter readings: monotonic per asset and unit, immutable
-- ---------------------------------------------------------------------------
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_value" CHECK ("value" >= 0);
CREATE OR REPLACE FUNCTION public."guardAssetMeterReading"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is immutable';
  END IF;
  -- Serialise readings of one asset: lock it.
  PERFORM 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "AssetMeterReading" r WHERE r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId" AND r."unit" = NEW."unit"
      AND ((r."readingDate" <= NEW."readingDate" AND r."value" > NEW."value") OR (r."readingDate" >= NEW."readingDate" AND r."value" < NEW."value"))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Meter readings are monotonic: never below an earlier reading nor above a later one';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetMeterReading_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssetMeterReading"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetMeterReading"();
CREATE TRIGGER "AssetMeterReading_no_truncate" BEFORE TRUNCATE ON "AssetMeterReading"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardAssetMeterReading"();

-- ---------------------------------------------------------------------------
-- C7 End of term
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_shape" CHECK (
  ("outcome" = 'PURCHASE') = ("purchasePriceExclVatCents" IS NOT NULL AND "purchaseValuationId" IS NOT NULL)
  AND ("purchasePriceExclVatCents" IS NULL OR "purchasePriceExclVatCents" > 0)
  AND ("outcome" = 'EXTEND' OR ("extensionNoticeOn" IS NULL AND "extensionEndsOn" IS NULL))
  AND ("status" = 'EXTENDING') <= ("outcome" = 'EXTEND')
  AND (("status" IN ('INSPECTED', 'INVOICED', 'COMPLETED') AND "outcome" <> 'PURCHASE')
        = ("inspectedOn" IS NOT NULL AND "inspectedById" IS NOT NULL AND length(btrim(COALESCE("inspectionCondition", ''))) >= 3))
  AND ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  AND ("excessUsageCents" IS NULL OR "excessUsageCents" >= 0)
);

CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
  ELSE
    IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
      OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
      OR NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"
      OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
      OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
      OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
        OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition"))
      OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
    END IF;
    IF OLD."status" = 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
      (OLD."status" = 'ELECTED' AND NEW."status" = 'INSPECTED' AND NEW."outcome" = 'RETURN')
      OR (OLD."status" = 'EXTENDING' AND NEW."status" = 'INSPECTED' AND NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" <= today)
      OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'INVOICED')
      OR (OLD."status" = 'ELECTED' AND NEW."status" = 'INVOICED' AND NEW."outcome" = 'PURCHASE')
      OR (OLD."status" = 'INVOICED' AND NEW."status" = 'COMPLETED')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s end of term cannot move from %s to %s', NEW."outcome", OLD."status", NEW."status");
    END IF;
    IF NEW."status" = 'COMPLETED' AND NEW."outcome" = 'PURCHASE'
      AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."outcome" = 'PURCHASE' THEN
    SELECT v."assetId", v."valuedOn", v."amountCents" INTO valuation FROM "AssetValuation" v
      WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
    IF valuation."assetId" IS DISTINCT FROM loan_row."assetId" OR valuation."valuedOn" < today - max_age
       OR NEW."purchasePriceExclVatCents" < valuation."amountCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: a valuation of this asset dated within %s days', max_age);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LeaseEndOfTerm_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaseEndOfTerm"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseEndOfTerm"();
CREATE TRIGGER "LeaseEndOfTerm_no_truncate" BEFORE TRUNCATE ON "LeaseEndOfTerm"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLeaseEndOfTerm"();

ALTER TABLE "LeaseDamageItem" ADD CONSTRAINT "LeaseDamageItem_shape" CHECK ("amountExclVatCents" > 0 AND length(btrim("description")) >= 3);
-- Damage is recorded with the inspection and is fixed once the end of term is invoiced.
CREATE OR REPLACE FUNCTION public."guardLeaseDamageItem"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A damage item is immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."id" = NEW."endOfTermId" AND e."tenantId" = NEW."tenantId" AND e."status" = 'INSPECTED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Damage is recorded on an inspected, not yet invoiced, return';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LeaseDamageItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaseDamageItem"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseDamageItem"();

-- A leased asset's lessor status, once set, never returns to none.
CREATE OR REPLACE FUNCTION public."guardAssetLessorStatus"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."lessorStatus" IS NOT NULL AND NEW."lessorStatus" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A leased asset''s lessor status is not cleared';
  END IF;
  IF OLD."lessorStatus" = 'SOLD_TO_LESSEE' AND NEW."lessorStatus" IS DISTINCT FROM OLD."lessorStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset sold to the lessee is not the lessor''s any more';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "FinancedAsset_lessor_status" BEFORE UPDATE OF "lessorStatus" ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetLessorStatus"();

-- ---------------------------------------------------------------------------
-- C8 Early termination
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_amounts" CHECK (
  "pvCents" >= 0 AND "penaltyCents" >= 0 AND "arrearsCents" >= 0 AND "invoiceVatCents" >= 0 AND "remainingRentals" >= 0
  AND "invoiceExclVatCents" = "pvCents" + "penaltyCents"
  AND "totalCents" = "invoiceExclVatCents" + "invoiceVatCents" + "arrearsCents"
  AND "validUntil" >= "quotedOn" AND "terminationDate" >= "quotedOn"
  AND length(btrim("basis")) >= 10
  AND ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
  AND ("status" = 'ACCEPTED' OR ("taxInvoiceId" IS NULL AND "scheduleId" IS NULL))
);
CREATE UNIQUE INDEX "LeaseTerminationQuote_one_accepted" ON "LeaseTerminationQuote"("loanId") WHERE "status" = 'ACCEPTED';

CREATE OR REPLACE FUNCTION public."guardLeaseTerminationQuote"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUOTED' OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
        AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND l."status" IN ('ACTIVE', 'DEFAULTED')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is written QUOTED for a running lease';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACCEPTED' AND (OLD."taxInvoiceId" IS NOT NULL OR OLD."scheduleId" IS NOT NULL OR NEW."status" <> 'ACCEPTED'
      OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An accepted termination quote is final once billed';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote''s figures are fixed when quoted';
  END IF;
  IF OLD."status" = 'QUOTED' AND NEW."status" = 'ACCEPTED' AND today > NEW."validUntil" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('The quote expired on %s', NEW."validUntil");
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LeaseTerminationQuote_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaseTerminationQuote"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseTerminationQuote"();
CREATE TRIGGER "LeaseTerminationQuote_no_truncate" BEFORE TRUNCATE ON "LeaseTerminationQuote"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLeaseTerminationQuote"();

-- ---------------------------------------------------------------------------
-- C8: an accepted early termination cancels the uninvoiced rentals after the
-- termination date. guardLeaseRental (20261014090000) is redefined: as there,
-- plus cancelledAt is set once, on an uninvoiced rental, only inside the
-- credaflow.lease_terminate flag; a cancelled rental is never invoiced; its
-- schedule row's total due is 0 (checkLeaseRentalSchedule).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardLeaseRental"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_type TEXT;
  invoice_row RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l."contractType"::TEXT INTO loan_type FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_type IS NULL OR loan_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental belongs to an operating or full-maintenance lease loan';
    END IF;
    IF loan_type = 'OPERATING_LEASE' AND NEW."maintenanceExclVatCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An operating lease rental carries no maintenance';
    END IF;
    IF NEW."taxInvoiceId" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is written uninvoiced';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId"
    OR NEW."periodNo" IS DISTINCT FROM OLD."periodNo" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s period, loan, schedule row and due date are fixed';
  END IF;
  IF OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is set once';
  END IF;
  IF NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" AND (
    OLD."cancelledAt" IS NOT NULL OR OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL
    OR current_setting('credaflow.lease_terminate', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is cancelled once, uninvoiced, only by an accepted early termination';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancelled lease rental is never invoiced';
  END IF;
  IF NEW."rentalExclVatCents" IS DISTINCT FROM OLD."rentalExclVatCents"
    OR NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents"
    OR NEW."vatCents" IS DISTINCT FROM OLD."vatCents"
    OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents"
    OR NEW."vatRate" IS DISTINCT FROM OLD."vatRate" THEN
    IF OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL OR OLD."cancelledAt" IS NOT NULL
      OR current_setting('credaflow.lease_reprice', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental''s amounts are fixed at booking; only a repricing changes them, before the rental is invoiced';
    END IF;
    IF NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repricing changes the rental, never the maintenance';
    END IF;
  END IF;
  IF OLD."taxInvoiceId" IS NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    SELECT i."loanId", i."totalInclVatCents" INTO invoice_row FROM "TaxInvoice" i
      WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId";
    IF invoice_row."loanId" IS DISTINCT FROM NEW."loanId" OR invoice_row."totalInclVatCents" IS DISTINCT FROM NEW."totalCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is of its loan, for the rental''s total';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."checkLeaseRentalSchedule"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  bad BOOLEAN;
BEGIN
  SELECT s."loanId" IS DISTINCT FROM r."loanId" OR s."installmentNo" IS DISTINCT FROM r."periodNo"
      OR s."totalDue" IS DISTINCT FROM (CASE WHEN r."cancelledAt" IS NULL THEN r."totalCents" ELSE 0 END)
    INTO bad
    FROM "LeaseRental" r JOIN "RepaymentSchedule" s ON s."id" = r."scheduleId" AND s."tenantId" = r."tenantId"
    WHERE (TG_TABLE_NAME = 'LeaseRental' AND r."id" = NEW."id") OR (TG_TABLE_NAME = 'RepaymentSchedule' AND s."id" = NEW."id");
  IF bad THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease rental and its schedule row must agree: same loan, period = instalment number, total = total due (0 once cancelled)';
  END IF;
  RETURN NULL;
END;
$function$;
