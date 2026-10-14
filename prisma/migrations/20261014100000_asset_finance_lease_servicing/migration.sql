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
-- RUN_ASSET_FINANCE_LEASE_IT case (lib/asset-finance/lease-servicing-rules-*.integration.test.ts).
-- ===========================================================================

-- The charge rows an end-of-term outcome or a termination bills (tenant-safe).
CREATE UNIQUE INDEX "LeaseEndOfTerm_tenantId_scheduleId_key" ON "LeaseEndOfTerm"("tenantId", "scheduleId");
CREATE UNIQUE INDEX "LeaseTerminationQuote_tenantId_scheduleId_key" ON "LeaseTerminationQuote"("tenantId", "scheduleId");
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
    -- Booking opens the fund before the deal names its loan: match on the application.
    SELECT d."maintenanceRiskModel"::TEXT INTO deal_model FROM "AssetFinanceDeal" d
      JOIN "Loan" l ON l."applicationId" = d."applicationId" AND l."tenantId" = d."tenantId"
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
  IF EXISTS (SELECT 1 FROM "MaintenanceClaim" c WHERE c."fundId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" IN ('SUBMITTED', 'APPROVED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund is settled with no claim open';
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
      WHERE r."id" = NEW."leaseRentalId" AND r."tenantId" = NEW."tenantId" AND f."id" = NEW."fundId" AND f."settledAt" IS NULL
        AND r."taxInvoiceId" IS NOT NULL AND r."maintenanceExclVatCents" = NEW."amountCents") INTO ok;
  ELSIF NEW."kind" = 'CLAIM' THEN
    SELECT EXISTS (SELECT 1 FROM "MaintenanceClaim" c JOIN "MaintenanceFund" f ON f."id" = c."fundId" AND f."tenantId" = c."tenantId"
      WHERE c."id" = NEW."claimId" AND c."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL
      AND c."fundId" = NEW."fundId" AND c."status" = 'PAID' AND c."amountExclVatCents" = NEW."amountCents") INTO ok;
  ELSE
    -- A settlement: of an unsettled lessee-settled fund, settled in the same
    -- transaction (checkSettlementMovement); a billed deficit on an invoice of the fund's loan.
    SELECT EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId"
      AND f."riskModel" = 'LESSEE_SETTLED' AND f."settledAt" IS NULL
      AND (NEW."kind" = 'SETTLEMENT_REFUND' OR EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId"
        AND i."tenantId" = NEW."tenantId" AND i."loanId" = f."loanId"))) INTO ok;
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

-- At commit, a settlement movement's fund is settled (the movement and the settlement are one act).
CREATE OR REPLACE FUNCTION public."checkSettlementMovement"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."kind" IN ('SETTLEMENT_REFUND', 'SETTLEMENT_BILLED') AND NOT EXISTS (
      SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId" AND f."settledAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A settlement movement settles its fund in the same transaction';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "MaintenanceFundMovement_settles_fund" AFTER INSERT ON "MaintenanceFundMovement"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkSettlementMovement"();

ALTER TABLE "MaintenanceClaim" ADD CONSTRAINT "MaintenanceClaim_shape" CHECK (
  "amountExclVatCents" > 0
  AND length(btrim("description")) >= 3
  AND num_nonnulls("firstApprovedById", "firstApprovedAt") IN (0, 2)
  AND ("status" IN ('APPROVED', 'PAID')) = ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
  AND ("status" = 'PAID') = ("paidById" IS NOT NULL AND "paidAt" IS NOT NULL AND length(btrim(COALESCE("paymentReference", ''))) >= 3)
  AND ("status" = 'REJECTED') = ("rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND length(btrim(COALESCE("rejectionReason", ''))) >= 5)
);
-- One live claim per provider invoice (a rejected claim frees it).
CREATE UNIQUE INDEX "MaintenanceClaim_one_per_invoice" ON "MaintenanceClaim"("providerInvoiceDocumentId") WHERE "status" <> 'REJECTED';

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
    SELECT f."leaseEndDate", f."settledAt", l."status"::TEXT AS loan_status, d."id" AS deal_id,
      EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."loanId" = l."id" AND e."status" = 'EXTENDING') AS extending INTO fund
      FROM "MaintenanceFund" f JOIN "Loan" l ON l."id" = f."loanId" AND l."tenantId" = f."tenantId"
      JOIN "AssetFinanceDeal" d ON d."loanId" = l."id" AND d."tenantId" = l."tenantId"
      WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId";
    IF NEW."status" <> 'SUBMITTED' OR NEW."firstApprovedById" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim is submitted unapproved';
    END IF;
    IF fund.loan_status NOT IN ('ACTIVE', 'DEFAULTED') OR (today > fund."leaseEndDate" AND NOT fund.extending) OR fund."settledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No maintenance claim after the lease ends or its fund is settled';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Supplier" s JOIN "SupplierBankAccount" a ON a."supplierId" = s."id" AND a."tenantId" = s."tenantId"
        WHERE s."id" = NEW."supplierId" AND s."tenantId" = NEW."tenantId" AND s."active" AND a."status" = 'APPROVED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance claim''s provider is an active supplier with an APPROVED bank account';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "EntityDocument" e WHERE e."id" = NEW."providerInvoiceDocumentId" AND e."tenantId" = NEW."tenantId"
        AND e."dealId" = fund.deal_id AND e."deletedAt" IS NULL AND e."docType" IN ('SUPPLIER_INVOICE', 'OTHER')) THEN
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
  IF (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" IN ('APPROVED', 'PAID') OR NEW."firstApprovedById" IS DISTINCT FROM OLD."firstApprovedById")
     AND EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId" AND f."settledAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A claim on a settled fund is only rejected';
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
  -- Never in the future (but for the start reading, dated the lease's start);
  -- a lease's reading is of its own asset, from its start.
  IF (NEW."readingDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date AND NOT EXISTS (
      SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND NEW."readingDate" = (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date))
    OR (NEW."loanId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."assetId"
        AND NEW."readingDate" >= (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is dated no later than today, of its lease''s asset, from the lease''s start';
  END IF;
  -- Serialise readings of one asset: lock it.
  PERFORM 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "AssetMeterReading" r WHERE r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId" AND r."unit" = NEW."unit"
      AND ((r."readingDate" <= NEW."readingDate" AND r."value" > NEW."value") OR (r."readingDate" > NEW."readingDate" AND r."value" < NEW."value"))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Meter readings are monotonic: never below an earlier (or same-day) reading nor above a later-dated one';
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
  ("outcome" = 'PURCHASE') = ("purchasePriceExclVatCents" IS NOT NULL)
  AND ("outcome" = 'PURCHASE') = ("purchaseValuationId" IS NOT NULL)
  AND ("purchasePriceExclVatCents" IS NULL OR "purchasePriceExclVatCents" > 0)
  AND ("outcome" = 'EXTEND' OR ("extensionNoticeOn" IS NULL AND "extensionEndsOn" IS NULL))
  AND ("status" = 'EXTENDING') <= ("outcome" = 'EXTEND')
  AND (("status" IN ('INSPECTED', 'INVOICED', 'COMPLETED') AND "outcome" <> 'PURCHASE')
        = ("inspectedOn" IS NOT NULL AND "inspectedById" IS NOT NULL AND length(btrim(COALESCE("inspectionCondition", ''))) >= 3))
  AND ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  AND ("excessUsageCents" IS NULL OR "excessUsageCents" >= 0)
  AND ("outcome" <> 'PURCHASE' OR "status" NOT IN ('INVOICED', 'COMPLETED') OR ("taxInvoiceId" IS NOT NULL AND "scheduleId" IS NOT NULL))
);

-- The day a lease's fixed term (or an extension's rentals) ends: its last
-- uncancelled rental's due date, a month later in advance (lib/asset-finance/lease-term-end.ts).
CREATE OR REPLACE FUNCTION public."leaseTermEnd"(loan_id TEXT, tenant_id TEXT)
RETURNS DATE LANGUAGE sql STABLE AS $function$
  SELECT CASE WHEN d."rentalTiming" = 'ADVANCE' THEN (MAX(r."dueDate") + INTERVAL '1 month')::date ELSE MAX(r."dueDate") END
  FROM "LeaseRental" r LEFT JOIN "AssetFinanceDeal" d ON d."loanId" = r."loanId" AND d."tenantId" = r."tenantId"
  WHERE r."loanId" = loan_id AND r."tenantId" = tenant_id AND r."cancelledAt" IS NULL
  GROUP BY d."rentalTiming";
$function$;

CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  returns_on DATE;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL
       OR NEW."inspectedOn" IS NOT NULL OR NEW."extensionNoticeOn" IS NOT NULL OR NEW."extensionEndsOn" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
    IF NEW."outcome" = 'PURCHASE' THEN
      -- Market value: an assessor's or a dealer's valuation of this asset, current, recorded by someone other than the elector.
      SELECT v."assetId", v."valuedOn", v."amountCents", v."source"::TEXT AS source, v."createdById" INTO valuation FROM "AssetValuation" v
        WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
      IF valuation."assetId" IS DISTINCT FROM loan_row."assetId" OR valuation."valuedOn" < today - max_age
         OR valuation.source NOT IN ('ASSESSOR', 'DEALER') OR NEW."purchasePriceExclVatCents" < valuation."amountCents"
         OR (NEW."electedById" IS NOT NULL AND valuation."createdById" IS NOT DISTINCT FROM NEW."electedById") THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
    OR NEW."electedById" IS DISTINCT FROM OLD."electedById" OR NEW."electedByClientId" IS DISTINCT FROM OLD."electedByClientId"
    OR NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"
    OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
    OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
    OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
      OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition" OR NEW."inspectedById" IS DISTINCT FROM OLD."inspectedById"))
    OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn")
    OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn")
    OR (OLD."natisTransferConfirmedAt" IS NOT NULL AND NEW."natisTransferConfirmedAt" IS DISTINCT FROM OLD."natisTransferConfirmedAt")
    OR (OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents" IS DISTINCT FROM OLD."excessUsageCents"
      OR NEW."fundSettlementCents" IS DISTINCT FROM OLD."fundSettlementCents")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
  END IF;
  -- Notice ends an extension a month on (or at its last appended rental), given between the election and today.
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL AND (
      NEW."outcome" <> 'EXTEND' OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
      OR NEW."extensionNoticeOn" > today OR NEW."extensionEndsOn" IS NULL
      OR NEW."extensionEndsOn" < (NEW."extensionNoticeOn" + INTERVAL '1 month')::date) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Notice is given between the election and today, and ends the extension at least a month later';
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
  IF NEW."status" = 'INSPECTED' AND OLD."status" <> 'INSPECTED' THEN
    -- The asset is inspected once it comes back: when the term (or the extension) ends, or on the accepted termination's date.
    returns_on := CASE
      WHEN NEW."origin" = 'EARLY_TERMINATION' THEN (SELECT q."terminationDate" FROM "LeaseTerminationQuote" q
        WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND q."status" = 'ACCEPTED')
      WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"
      ELSE public."leaseTermEnd"(NEW."loanId", NEW."tenantId") END;
    IF returns_on IS NULL OR NEW."inspectedOn" < returns_on OR NEW."inspectedOn" > today
       OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A return is inspected from the day the asset comes back, after the election, never in the future';
    END IF;
    -- The final reading is this lease's asset's, taken at the inspection, and the latest.
    IF NEW."finalReadingId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."finalReadingId" AND m."tenantId" = NEW."tenantId"
          AND m."assetId" = loan_row."assetId" AND m."readingDate" = NEW."inspectedOn"
          AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" x WHERE x."tenantId" = m."tenantId" AND x."assetId" = m."assetId"
            AND x."unit" = m."unit" AND x."readingDate" > m."readingDate")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final reading is the lease''s asset''s latest, taken at the inspection';
    END IF;
  END IF;
  IF NEW."status" = 'INVOICED' AND OLD."status" = 'ELECTED' THEN
    -- A purchase is sold when the term ends, on a valuation still current.
    SELECT v."valuedOn" INTO valuation FROM "AssetValuation" v WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    IF today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR valuation."valuedOn" < today - max_age THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is invoiced when the term ends, on a current valuation';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."totalPaid" < r."totalDue") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term completes once everything owed on the lease is paid';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
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
  IF NEW."lessorStatus" = 'SOLD_TO_LESSEE' AND OLD."lessorStatus" IS DISTINCT FROM NEW."lessorStatus" AND NOT EXISTS (
      SELECT 1 FROM "LeaseEndOfTerm" e JOIN "Loan" l ON l."id" = e."loanId" AND l."tenantId" = e."tenantId"
      WHERE l."assetId" = NEW."id" AND l."tenantId" = NEW."tenantId" AND e."outcome" = 'PURCHASE' AND e."status" = 'COMPLETED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset is sold to the lessee by a completed purchase';
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
-- An accepted quote with something to invoice carries its invoice and charge row.
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_accepted_billed" CHECK (
  "status" <> 'ACCEPTED' OR "invoiceExclVatCents" = 0 OR ("taxInvoiceId" IS NOT NULL AND "scheduleId" IS NOT NULL)
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
    IF NEW."quotedOn" <> today OR NEW."validUntil" > today + COALESCE((SELECT c."leaseTerminationQuoteValidDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is dated today and valid for the tenant''s days at most';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACCEPTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An accepted termination quote is final';
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
-- C7–C8: guardLeaseRental, checkLeaseRentalSchedule and checkLeaseScheduleRow
-- (20261014090000) redefined, unchanged but for: a month-to-month
-- extension's next rental may be written after booking (the next period, a
-- month after the last, at the last rental and maintenance, within the
-- extension); an accepted early termination cancels the uninvoiced rentals
-- after its termination date (cancelledAt set once, uninvoiced, inside the
-- credaflow.lease_terminate flag and with a QUOTED termination of the loan
-- whose date it is after); a cancelled rental is never invoiced or repriced
-- and its schedule row is 0; a lease's schedule may also carry the charge row
-- of its end of term or termination (LeaseEndOfTerm / LeaseTerminationQuote.scheduleId).
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
    -- Only booking writes rentals: its deal is not BOOKED yet (it becomes
    -- BOOKED later in the same transaction; guardLeaseDealBooking).
    -- After booking, only a month-to-month extension's next rental: the next
    -- period, one month after the last, at the last rental and maintenance
    -- (lib/asset-finance/lease-charges.ts appendExtensionRental).
    IF EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."loanId" = NEW."loanId" AND d."tenantId" = NEW."tenantId" AND d."status" = 'BOOKED')
      AND NOT EXISTS (
        SELECT 1 FROM "LeaseEndOfTerm" e
        JOIN LATERAL (SELECT r.* FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" ORDER BY r."periodNo" DESC LIMIT 1) last ON TRUE
        WHERE e."loanId" = NEW."loanId" AND e."tenantId" = NEW."tenantId" AND e."status" = 'EXTENDING'
          AND (e."extensionEndsOn" IS NULL OR NEW."dueDate" <= e."extensionEndsOn")
          AND NEW."periodNo" = last."periodNo" + 1
          AND NEW."dueDate" = (last."dueDate" + INTERVAL '1 month')::date
          AND NEW."rentalExclVatCents" = last."rentalExclVatCents" AND NEW."maintenanceExclVatCents" = last."maintenanceExclVatCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s rentals are written when it is booked, or one at a time on a month-to-month extension';
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
    OR current_setting('credaflow.lease_terminate', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
      AND q."status" = 'QUOTED' AND NEW."dueDate" > q."terminationDate"
      AND q."validUntil" >= (now() AT TIME ZONE 'Africa/Johannesburg')::date)) THEN
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
      OR current_setting('credaflow.lease_reprice', true) IS DISTINCT FROM 'on'
      OR NOT EXISTS (
        SELECT 1 FROM "ContractRate" c WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId"
          AND c."xmin" = pg_current_xact_id()::xid AND c."basis" <> 'FIXED' AND NEW."dueDate" >= c."effectiveDate"
          AND c."resultingRate" IS DISTINCT FROM (SELECT p."resultingRate" FROM "ContractRate" p WHERE p."loanId" = c."loanId"
            AND p."effectiveDate" < c."effectiveDate" ORDER BY p."effectiveDate" DESC LIMIT 1)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental''s amounts are fixed at booking; only a repricing changes them, before the rental is invoiced';
    END IF;
    IF NEW."vatRate" IS DISTINCT FROM OLD."vatRate"
      OR NEW."vatCents" <> "vatHalfUpCents"(NEW."rentalExclVatCents", NEW."vatRate") + "vatHalfUpCents"(NEW."maintenanceExclVatCents", NEW."vatRate") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repriced rental keeps its booked VAT rate, its VAT recomputed on it';
    END IF;
    IF NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repricing changes the rental, never the maintenance';
    END IF;
  END IF;
  IF OLD."taxInvoiceId" IS NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    SELECT i."loanId", i."totalInclVatCents", i."supplyDate" INTO invoice_row FROM "TaxInvoice" i
      WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId";
    IF invoice_row."loanId" IS DISTINCT FROM NEW."loanId" OR invoice_row."totalInclVatCents" IS DISTINCT FROM NEW."totalCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is of its loan, for the rental''s total';
    END IF;
    -- Time of supply: the earlier of the due date and a payment towards the
    -- rental. Receipts settle the oldest rows first, so a payment has reached
    -- this rental only once the cash received by the supply date (allocated,
    -- unreversed, not a waiver or a refund-due half, net of default charges)
    -- exceeds everything due on the earlier rows.
    IF invoice_row."supplyDate" > NEW."dueDate" OR (invoice_row."supplyDate" < NEW."dueDate" AND (NOT EXISTS (
        SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = NEW."scheduleId" AND s."tenantId" = NEW."tenantId" AND s."totalPaid" > 0)
      OR (SELECT COALESCE(SUM(p."amount" - p."defaultInterestAllocated" - p."chargeFeesAllocated"), 0) FROM "Payment" p
          WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId" AND p."reversed" = false
            AND p."allocationStatus" = 'ALLOCATED' AND p."paymentMethod"::TEXT <> 'WAIVER' AND p."parentPaymentId" IS NULL
            AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= invoice_row."supplyDate")
        <= (SELECT COALESCE(SUM(s."totalDue"), 0) FROM "RepaymentSchedule" s
          WHERE s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId" AND s."installmentNo" < NEW."periodNo"))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental is supplied on its due date, or earlier only once a payment has reached it';
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
  IF TG_TABLE_NAME = 'LeaseRental' THEN
    SELECT s."loanId" IS DISTINCT FROM r."loanId" OR s."installmentNo" IS DISTINCT FROM r."periodNo" OR s."totalDue" IS DISTINCT FROM (CASE WHEN r."cancelledAt" IS NULL THEN r."totalCents" ELSE 0 END)
      OR (s."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date IS DISTINCT FROM r."dueDate"
      INTO bad
      FROM "LeaseRental" r JOIN "RepaymentSchedule" s ON s."id" = r."scheduleId" AND s."tenantId" = r."tenantId"
      WHERE r."id" = NEW."id";
  ELSE
    SELECT s."loanId" IS DISTINCT FROM r."loanId" OR s."installmentNo" IS DISTINCT FROM r."periodNo" OR s."totalDue" IS DISTINCT FROM (CASE WHEN r."cancelledAt" IS NULL THEN r."totalCents" ELSE 0 END)
      OR (s."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date IS DISTINCT FROM r."dueDate"
      INTO bad
      FROM "LeaseRental" r JOIN "RepaymentSchedule" s ON s."id" = r."scheduleId" AND s."tenantId" = r."tenantId"
      WHERE s."id" = NEW."id";
  END IF;
  IF bad THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease rental and its schedule row must agree: same loan, period = instalment number, total = total due (0 once cancelled), same due date';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public."checkLeaseScheduleRow"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE'))
    AND NOT EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."scheduleId" = NEW."id" AND r."tenantId" = NEW."tenantId")
    AND NOT EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."scheduleId" = NEW."id" AND e."tenantId" = NEW."tenantId")
    AND NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."scheduleId" = NEW."id" AND q."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan''s schedule row is one of its rentals, or the charge of its end of term or termination';
  END IF;
  RETURN NULL;
END;
$function$;

-- A lease's charge (its end of term's or termination's) is a tax invoice of
-- its own loan, never a rental's invoice, never shared between the two, and
-- for a termination exactly the quoted invoice amount; its schedule row is a
-- fresh row of the same loan (never a rental's row) whose total due is that
-- invoice's total, never adjusted later.
CREATE OR REPLACE FUNCTION public."leaseChargeRowMismatch"(schedule_id TEXT, tenant_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM (
      SELECT e."loanId", e."taxInvoiceId" FROM "LeaseEndOfTerm" e WHERE e."scheduleId" = schedule_id AND e."tenantId" = tenant_id
      UNION ALL
      SELECT q."loanId", q."taxInvoiceId" FROM "LeaseTerminationQuote" q WHERE q."scheduleId" = schedule_id AND q."tenantId" = tenant_id
    ) c
    LEFT JOIN "RepaymentSchedule" s ON s."id" = schedule_id AND s."tenantId" = tenant_id
    LEFT JOIN "TaxInvoice" i ON i."id" = c."taxInvoiceId" AND i."tenantId" = tenant_id
    WHERE s."id" IS NULL OR i."id" IS NULL OR s."loanId" IS DISTINCT FROM c."loanId" OR i."loanId" IS DISTINCT FROM c."loanId"
      OR s."totalDue" IS DISTINCT FROM i."totalInclVatCents"
      OR EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."tenantId" = tenant_id AND (r."scheduleId" = schedule_id OR r."taxInvoiceId" = c."taxInvoiceId"))
  ) OR (
    SELECT count(*) FROM (
      SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."scheduleId" = schedule_id AND e."tenantId" = tenant_id
      UNION ALL SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."scheduleId" = schedule_id AND q."tenantId" = tenant_id
    ) n
  ) > 1;
$function$;

CREATE OR REPLACE FUNCTION public."checkLeaseChargeLink"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."taxInvoiceId" IS NOT NULL AND (
      NOT EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId" AND i."loanId" = NEW."loanId"
        AND (TG_TABLE_NAME <> 'LeaseTerminationQuote'
          OR i."totalInclVatCents" = (to_jsonb(NEW) ->> 'invoiceExclVatCents')::INTEGER + (to_jsonb(NEW) ->> 'invoiceVatCents')::INTEGER))
      OR EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."taxInvoiceId" = NEW."taxInvoiceId" AND r."tenantId" = NEW."tenantId")
      OR EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."taxInvoiceId" = NEW."taxInvoiceId" AND e."tenantId" = NEW."tenantId" AND e."id" <> NEW."id")
      OR EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."taxInvoiceId" = NEW."taxInvoiceId" AND q."tenantId" = NEW."tenantId" AND q."id" <> NEW."id")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease charge''s tax invoice is its own loan''s, not a rental''s, not shared, and a termination''s is the quoted amount';
  END IF;
  IF NEW."scheduleId" IS NOT NULL AND "leaseChargeRowMismatch"(NEW."scheduleId", NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease charge row is a schedule row of its own loan, not a rental''s, its total due its tax invoice''s total';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "LeaseEndOfTerm_charge_row" AFTER INSERT OR UPDATE OF "scheduleId", "taxInvoiceId" ON "LeaseEndOfTerm"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseChargeLink"();
CREATE CONSTRAINT TRIGGER "LeaseTerminationQuote_charge_row" AFTER INSERT OR UPDATE OF "scheduleId", "taxInvoiceId" ON "LeaseTerminationQuote"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseChargeLink"();

CREATE OR REPLACE FUNCTION public."checkLeaseChargeRowTotal"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF "leaseChargeRowMismatch"(NEW."id", NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease charge row''s total due is its tax invoice''s total';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "RepaymentSchedule_lease_charge_total" AFTER UPDATE OF "totalDue", "loanId" ON "RepaymentSchedule"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseChargeRowTotal"();

-- At commit, a rental cancelled in this transaction rests on a termination
-- quote of its loan accepted in this same transaction, ending before it.
CREATE OR REPLACE FUNCTION public."checkLeaseRentalCancelled"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."cancelledAt" IS NOT NULL AND OLD."cancelledAt" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND q."status" = 'ACCEPTED' AND q."xmin" = pg_current_xact_id()::xid AND NEW."dueDate" > q."terminationDate") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rental is cancelled only by a termination accepted with it';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "LeaseRental_cancelled_by_acceptance" AFTER UPDATE OF "cancelledAt" ON "LeaseRental"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseRentalCancelled"();

-- The lease settings stay in range: a threshold so high it switches dual approval off is refused.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_lease_settings" CHECK (
  "maintenanceClaimDualApprovalCents" BETWEEN 1 AND 1000000000
  AND "leasePurchaseValuationMaxAgeDays" BETWEEN 1 AND 180
  AND "leaseTerminationQuoteValidDays" BETWEEN 1 AND 60
);
