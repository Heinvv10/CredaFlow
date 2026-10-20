-- CreateEnum
CREATE TYPE "DealerKind" AS ENUM ('DEALER', 'BROKER');

-- CreateEnum
CREATE TYPE "DealerRole" AS ENUM ('DEALER_ADMIN', 'DEALER_SALES');

-- CreateEnum
CREATE TYPE "DealerCommissionLineKind" AS ENUM ('EARNED', 'REVERSED');

-- CreateEnum
CREATE TYPE "DealerCommissionReversalReason" AS ENUM ('LOAN_SETTLED_EARLY', 'LOAN_WRITTEN_OFF', 'LOAN_CANCELLED');

-- CreateEnum
CREATE TYPE "DealerCommissionRateSource" AS ENUM ('DEALER', 'TENANT_DEFAULT', 'NONE');

-- CreateEnum
CREATE TYPE "DealerPayableRunStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DealerBankAccountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "AssetFinanceDeal" ADD COLUMN     "dealerCommissionBaseCents" INTEGER,
ADD COLUMN     "dealerCommissionBps" INTEGER,
ADD COLUMN     "dealerCommissionFlatCents" INTEGER,
ADD COLUMN     "dealerCommissionRateId" TEXT,
ADD COLUMN     "dealerCommissionSnapshotAt" TIMESTAMP(3),
ADD COLUMN     "dealerCommissionSource" "DealerCommissionRateSource",
ADD COLUMN     "dealerId" TEXT,
ADD COLUMN     "dealerSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "dealerUserId" TEXT;

-- AlterTable
ALTER TABLE "BusinessEntity" ADD COLUMN     "createdByDealerId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "createdByDealerId" TEXT;

-- AlterTable
ALTER TABLE "FinancedAsset" ADD COLUMN     "createdByDealerId" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "dealerCommissionClawbackMonths" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "featureDealerPortal" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Dealer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DealerKind" NOT NULL,
    "registrationNumber" TEXT,
    "vatNumber" TEXT,
    "vatVendor" BOOLEAN NOT NULL DEFAULT false,
    "supplierId" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dealer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerUser" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "DealerRole" NOT NULL,
    "passwordHash" TEXT,
    "setPasswordTokenHash" TEXT,
    "setPasswordTokenExp" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdByDealerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerCommissionRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealerId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "bps" INTEGER NOT NULL,
    "flatCents" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerCommissionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerCommissionLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "kind" "DealerCommissionLineKind" NOT NULL,
    "reversesLineId" TEXT,
    "reason" "DealerCommissionReversalReason",
    "effectiveOn" DATE NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "bps" INTEGER NOT NULL,
    "flatCents" INTEGER NOT NULL,
    "netCents" INTEGER NOT NULL,
    "vatRate" DECIMAL(6,4) NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "dealerVatVendor" BOOLEAN NOT NULL,
    "clawbackMonths" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerCommissionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerPayableRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "status" "DealerPayableRunStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "totalNetCents" INTEGER NOT NULL,
    "totalVatCents" INTEGER NOT NULL,
    "totalGrossCents" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releaseReference" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerPayableRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerPayableRunLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerPayableRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerBankAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealerId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "accountType" TEXT,
    "status" "DealerBankAccountStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "avsResult" JSONB,
    "avsPassed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealerBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerConsentAttestation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "dealerUserId" TEXT NOT NULL,
    "statementVersion" TEXT NOT NULL,
    "statementText" TEXT NOT NULL,
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "DealerConsentAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealerDocumentRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "docType" "EntityDocumentType" NOT NULL,
    "note" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfilledDocumentId" TEXT,
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "DealerDocumentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dealer_tenantId_id_key" ON "Dealer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Dealer_tenantId_name_key" ON "Dealer"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Dealer_tenantId_supplierId_key" ON "Dealer"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerUser_setPasswordTokenHash_key" ON "DealerUser"("setPasswordTokenHash");

-- CreateIndex
CREATE INDEX "DealerUser_tenantId_dealerId_idx" ON "DealerUser"("tenantId", "dealerId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerUser_tenantId_id_key" ON "DealerUser"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DealerUser_tenantId_email_key" ON "DealerUser"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "DealerCommissionRate_tenantId_id_key" ON "DealerCommissionRate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DealerCommissionRate_tenantId_dealerId_effectiveFrom_key" ON "DealerCommissionRate"("tenantId", "dealerId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "DealerCommissionLine_reversesLineId_key" ON "DealerCommissionLine"("reversesLineId");

-- CreateIndex
CREATE INDEX "DealerCommissionLine_tenantId_dealerId_effectiveOn_idx" ON "DealerCommissionLine"("tenantId", "dealerId", "effectiveOn");

-- CreateIndex
CREATE INDEX "DealerCommissionLine_tenantId_loanId_idx" ON "DealerCommissionLine"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerCommissionLine_tenantId_id_key" ON "DealerCommissionLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DealerCommissionLine_tenantId_reversesLineId_key" ON "DealerCommissionLine"("tenantId", "reversesLineId");

-- CreateIndex
CREATE INDEX "DealerPayableRun_tenantId_dealerId_status_idx" ON "DealerPayableRun"("tenantId", "dealerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DealerPayableRun_tenantId_id_key" ON "DealerPayableRun"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DealerPayableRunLine_tenantId_runId_idx" ON "DealerPayableRunLine"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerPayableRunLine_tenantId_id_key" ON "DealerPayableRunLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DealerBankAccount_tenantId_dealerId_idx" ON "DealerBankAccount"("tenantId", "dealerId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerBankAccount_tenantId_id_key" ON "DealerBankAccount"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DealerConsentAttestation_tenantId_dealId_idx" ON "DealerConsentAttestation"("tenantId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerConsentAttestation_tenantId_id_key" ON "DealerConsentAttestation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "DealerDocumentRequest_tenantId_dealId_idx" ON "DealerDocumentRequest"("tenantId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "DealerDocumentRequest_tenantId_id_key" ON "DealerDocumentRequest"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AssetFinanceDeal_tenantId_dealerId_status_idx" ON "AssetFinanceDeal"("tenantId", "dealerId", "status");

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_tenantId_deactivatedById_fkey" FOREIGN KEY ("tenantId", "deactivatedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerUser" ADD CONSTRAINT "DealerUser_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerUser" ADD CONSTRAINT "DealerUser_tenantId_createdByUserId_fkey" FOREIGN KEY ("tenantId", "createdByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerUser" ADD CONSTRAINT "DealerUser_tenantId_createdByDealerUserId_fkey" FOREIGN KEY ("tenantId", "createdByDealerUserId") REFERENCES "DealerUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionRate" ADD CONSTRAINT "DealerCommissionRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerCommissionRate" ADD CONSTRAINT "DealerCommissionRate_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionRate" ADD CONSTRAINT "DealerCommissionRate_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionLine" ADD CONSTRAINT "DealerCommissionLine_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionLine" ADD CONSTRAINT "DealerCommissionLine_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionLine" ADD CONSTRAINT "DealerCommissionLine_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerCommissionLine" ADD CONSTRAINT "DealerCommissionLine_tenantId_reversesLineId_fkey" FOREIGN KEY ("tenantId", "reversesLineId") REFERENCES "DealerCommissionLine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_bankAccountId_fkey" FOREIGN KEY ("tenantId", "bankAccountId") REFERENCES "DealerBankAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_releasedById_fkey" FOREIGN KEY ("tenantId", "releasedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tenantId_cancelledById_fkey" FOREIGN KEY ("tenantId", "cancelledById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRunLine" ADD CONSTRAINT "DealerPayableRunLine_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "DealerPayableRun"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerPayableRunLine" ADD CONSTRAINT "DealerPayableRunLine_tenantId_lineId_fkey" FOREIGN KEY ("tenantId", "lineId") REFERENCES "DealerCommissionLine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_tenantId_dealerUserId_fkey" FOREIGN KEY ("tenantId", "dealerUserId") REFERENCES "DealerUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_tenantId_verifiedById_fkey" FOREIGN KEY ("tenantId", "verifiedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerDocumentRequest" ADD CONSTRAINT "DealerDocumentRequest_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerDocumentRequest" ADD CONSTRAINT "DealerDocumentRequest_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealerDocumentRequest" ADD CONSTRAINT "DealerDocumentRequest_tenantId_fulfilledDocumentId_fkey" FOREIGN KEY ("tenantId", "fulfilledDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BusinessEntity" ADD CONSTRAINT "BusinessEntity_tenantId_createdByDealerId_fkey" FOREIGN KEY ("tenantId", "createdByDealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_tenantId_createdByDealerId_fkey" FOREIGN KEY ("tenantId", "createdByDealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_dealerId_fkey" FOREIGN KEY ("tenantId", "dealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_dealerUserId_fkey" FOREIGN KEY ("tenantId", "dealerUserId") REFERENCES "DealerUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_dealerCommissionRateId_fkey" FOREIGN KEY ("tenantId", "dealerCommissionRateId") REFERENCES "DealerCommissionRate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_createdByDealerId_fkey" FOREIGN KEY ("tenantId", "createdByDealerId") REFERENCES "Dealer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written: dealer portal and commission (docs/asset-finance/SLICE5.md
-- part A, "CHECKs" and "Triggers and functions"). Every refusal is SQLSTATE
-- 23514; every guard trigger has a _no_truncate statement trigger; "today" is
-- the Johannesburg calendar date. Tests: lib/dealer/*.integration.test.ts
-- (RUN_ASSET_FINANCE_DEALER_IT).
-- ---------------------------------------------------------------------------

-- The portal signs dealers in with a password only until dealer 2FA ships, so
-- it can be on only for a synthetic demo lender. isDemoLender is a column of
-- the same row: the CHECK also refuses clearing it while the portal is on.
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_dealer_portal_demo_only" CHECK (NOT "featureDealerPortal" OR "isDemoLender");
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_dealer_clawback_months_range" CHECK ("dealerCommissionClawbackMonths" BETWEEN 0 AND 60);

-- Dealers ------------------------------------------------------------------

ALTER TABLE "Dealer" ADD CONSTRAINT "Dealer_vat_vendor_shape" CHECK ("vatVendor" = ("vatNumber" IS NOT NULL));

CREATE OR REPLACE FUNCTION "guardDealer"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer is never deleted: deactivate it';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer''s tenant and creator are fixed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Dealer_guard" BEFORE UPDATE OR DELETE ON "Dealer"
  FOR EACH ROW EXECUTE FUNCTION "guardDealer"();
CREATE TRIGGER "Dealer_no_truncate" BEFORE TRUNCATE ON "Dealer"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealer"();

-- Created by staff, or by a user of the same dealer (the API allows only a
-- DEALER_ADMIN to). A session ends by bumping tokenVersion, so it never falls.
ALTER TABLE "DealerUser" ADD CONSTRAINT "DealerUser_creator_xor" CHECK (num_nonnulls("createdByUserId", "createdByDealerUserId") = 1);

CREATE OR REPLACE FUNCTION "guardDealerUser"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer user is never deleted: deactivate it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."createdByDealerUserId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "DealerUser" u
      WHERE u."id" = NEW."createdByDealerUserId" AND u."tenantId" = NEW."tenantId" AND u."dealerId" = NEW."dealerId"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer user creates users of its own dealer only';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."dealerId" IS DISTINCT FROM OLD."dealerId"
    OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" OR NEW."createdByDealerUserId" IS DISTINCT FROM OLD."createdByDealerUserId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer user''s tenant, dealer and creator are fixed';
  END IF;
  IF NEW."tokenVersion" < OLD."tokenVersion" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer user''s tokenVersion only increases';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerUser_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerUser"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerUser"();
CREATE TRIGGER "DealerUser_no_truncate" BEFORE TRUNCATE ON "DealerUser"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerUser"();

-- Commission rates ---------------------------------------------------------

-- A sanity ceiling of 10 % and R100 000, changed only by migration.
ALTER TABLE "DealerCommissionRate" ADD CONSTRAINT "DealerCommissionRate_bounds" CHECK ("bps" BETWEEN 0 AND 1000 AND "flatCents" BETWEEN 0 AND 10000000);
-- The (tenantId, dealerId, effectiveFrom) unique key treats NULL dealers as distinct.
CREATE UNIQUE INDEX "DealerCommissionRate_one_default_per_date" ON "DealerCommissionRate" ("tenantId", "effectiveFrom") WHERE "dealerId" IS NULL;

-- History: a row is inserted for any date, never edited, and withdrawn only
-- while it is not yet in force (an approval may already have snapshotted it).
CREATE OR REPLACE FUNCTION "guardDealerCommissionRate"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A commission rate is never edited or truncated: add a row with a new effective date';
  END IF;
  IF OLD."effectiveFrom" <= (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a commission rate not yet in force may be withdrawn';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE TRIGGER "DealerCommissionRate_guard" BEFORE UPDATE OR DELETE ON "DealerCommissionRate"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerCommissionRate"();
CREATE TRIGGER "DealerCommissionRate_no_truncate" BEFORE TRUNCATE ON "DealerCommissionRate"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerCommissionRate"();

-- The rate in force on a date: the dealer's latest row from on or before it,
-- else the tenant default's, else no commission.
CREATE OR REPLACE FUNCTION "dealerCommissionRateAt"(p_tenant TEXT, p_dealer TEXT, p_on DATE)
RETURNS TABLE ("rateId" TEXT, "source" "DealerCommissionRateSource", "bps" INTEGER, "flatCents" INTEGER)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  RETURN QUERY SELECT r."id", 'DEALER'::"DealerCommissionRateSource", r."bps", r."flatCents"
    FROM "DealerCommissionRate" r
    WHERE r."tenantId" = p_tenant AND r."dealerId" = p_dealer AND r."effectiveFrom" <= p_on
    ORDER BY r."effectiveFrom" DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT r."id", 'TENANT_DEFAULT'::"DealerCommissionRateSource", r."bps", r."flatCents"
    FROM "DealerCommissionRate" r
    WHERE r."tenantId" = p_tenant AND r."dealerId" IS NULL AND r."effectiveFrom" <= p_on
    ORDER BY r."effectiveFrom" DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT NULL::TEXT, 'NONE'::"DealerCommissionRateSource", 0, 0;
END;
$function$;

-- Commission ex VAT: base × bps / 10 000 rounded half up, plus the flat amount
-- (lib/dealer/commission-math.ts mirrors it for display).
CREATE OR REPLACE FUNCTION "dealerCommissionNetCents"(p_base INTEGER, p_bps INTEGER, p_flat INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT (round(p_base::numeric * p_bps / 10000) + p_flat)::INTEGER
$function$;

-- VAT on commission: only a VAT vendor charges it. UNTESTED: tax review (SLICE5.md "Review items").
CREATE OR REPLACE FUNCTION "dealerCommissionVatCents"(p_net INTEGER, p_rate NUMERIC, p_vendor BOOLEAN)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE WHEN p_vendor THEN round(p_net * p_rate)::INTEGER ELSE 0 END
$function$;

CREATE OR REPLACE FUNCTION "dealerCommissionVatRateOn"(p_on DATE)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $function$
  SELECT v."rate" FROM "VatRate" v WHERE v."effectiveDate" <= p_on ORDER BY v."effectiveDate" DESC LIMIT 1
$function$;

-- Dealer deals ------------------------------------------------------------

ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_dealer_pair" CHECK (
  ("dealerId" IS NULL) = ("dealerUserId" IS NULL)
  AND ("dealerUserId" IS NULL OR "createdById" = "dealerUserId")
  AND ("dealerSubmittedAt" IS NULL OR "dealerId" IS NOT NULL)
);
-- The snapshot is all or nothing, only on a dealer deal; the rate row is
-- absent exactly when no rate was in force (source NONE).
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_dealer_snapshot_shape" CHECK (
  num_nonnulls("dealerCommissionSource", "dealerCommissionRateId", "dealerCommissionBps", "dealerCommissionFlatCents",
    "dealerCommissionBaseCents", "dealerCommissionSnapshotAt") = 0
  OR ("dealerId" IS NOT NULL
    AND num_nonnulls("dealerCommissionSource", "dealerCommissionBps", "dealerCommissionFlatCents", "dealerCommissionBaseCents",
      "dealerCommissionSnapshotAt") = 5
    AND ("dealerCommissionRateId" IS NULL) = ("dealerCommissionSource" = 'NONE'))
);

-- A dealer deal: an active dealer of the lender, created by an active user of
-- that dealer, with the portal on, on a borrower and asset that dealer
-- captured. The dealer is fixed; dealerSubmittedAt is set once, while DRAFT.
-- On the move into APPROVED the database takes the commission snapshot (rate
-- in force today, base = the approved amount); nobody else ever writes it.
CREATE OR REPLACE FUNCTION "guardAssetDealDealer"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  rate RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dealerId" IS NULL THEN
      RETURN NEW; -- a staff deal: the CHECKs keep its dealer columns empty
    END IF;
    IF NEW."dealerSubmittedAt" IS NOT NULL OR num_nonnulls(NEW."dealerCommissionSource", NEW."dealerCommissionRateId", NEW."dealerCommissionBps",
        NEW."dealerCommissionFlatCents", NEW."dealerCommissionBaseCents", NEW."dealerCommissionSnapshotAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal is created unsubmitted and without a commission snapshot';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Dealer" d WHERE d."id" = NEW."dealerId" AND d."tenantId" = NEW."tenantId" AND d."active") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal names an active dealer of the lender';
    END IF;
    IF NEW."dealerUserId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "DealerUser" u
      WHERE u."id" = NEW."dealerUserId" AND u."tenantId" = NEW."tenantId" AND u."dealerId" = NEW."dealerId" AND u."active"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal is created by an active user of that dealer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId" AND c."featureDealerPortal") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The dealer portal is off for this lender';
    END IF;
    IF NOT (
      (NEW."entityId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "BusinessEntity" e WHERE e."id" = NEW."entityId" AND e."tenantId" = NEW."tenantId" AND e."createdByDealerId" = NEW."dealerId"))
      OR (NEW."clientId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Client" c WHERE c."id" = NEW."clientId" AND c."tenantId" = NEW."tenantId" AND c."createdByDealerId" = NEW."dealerId"))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal''s borrower was captured by that dealer';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" AND a."createdByDealerId" = NEW."dealerId"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal''s asset was captured by that dealer';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."dealerId" IS DISTINCT FROM OLD."dealerId" OR NEW."dealerUserId" IS DISTINCT FROM OLD."dealerUserId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal''s dealer is fixed when it is created';
  END IF;
  IF NEW."dealerSubmittedAt" IS DISTINCT FROM OLD."dealerSubmittedAt"
    AND (OLD."dealerSubmittedAt" IS NOT NULL OR OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer submits a deal once, while it is DRAFT';
  END IF;
  IF ROW(NEW."dealerCommissionSource", NEW."dealerCommissionRateId", NEW."dealerCommissionBps", NEW."dealerCommissionFlatCents",
      NEW."dealerCommissionBaseCents", NEW."dealerCommissionSnapshotAt")
    IS DISTINCT FROM ROW(OLD."dealerCommissionSource", OLD."dealerCommissionRateId", OLD."dealerCommissionBps", OLD."dealerCommissionFlatCents",
      OLD."dealerCommissionBaseCents", OLD."dealerCommissionSnapshotAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The commission snapshot is the database''s: taken when the deal is approved, never changed';
  END IF;
  IF NEW."dealerId" IS NOT NULL AND NEW."status" = 'APPROVED' AND OLD."status" IS DISTINCT FROM 'APPROVED' THEN
    SELECT * INTO rate FROM "dealerCommissionRateAt"(NEW."tenantId", NEW."dealerId", today);
    NEW."dealerCommissionSource" := rate."source";
    NEW."dealerCommissionRateId" := rate."rateId";
    NEW."dealerCommissionBps" := rate."bps";
    NEW."dealerCommissionFlatCents" := rate."flatCents";
    NEW."dealerCommissionBaseCents" := (
      SELECT COALESCE(a."approvedAmount", a."appliedAmount") FROM "LoanApplication" a
      WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId"
    );
    NEW."dealerCommissionSnapshotAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_dealer_guard" BEFORE INSERT OR UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION "guardAssetDealDealer"();

-- Commission lines ---------------------------------------------------------

ALTER TABLE "DealerCommissionLine" ADD CONSTRAINT "DealerCommissionLine_shape" CHECK (
  (("kind" = 'EARNED' AND "reversesLineId" IS NULL AND "reason" IS NULL AND "netCents" > 0)
    OR ("kind" = 'REVERSED' AND "reversesLineId" IS NOT NULL AND "reason" IS NOT NULL AND "netCents" < 0))
  AND "grossCents" = "netCents" + "vatCents"
  AND ("dealerVatVendor" OR "vatCents" = 0)
);
CREATE UNIQUE INDEX "DealerCommissionLine_one_earned_per_deal" ON "DealerCommissionLine" ("tenantId", "dealId") WHERE "kind" = 'EARNED';

-- A line is inserted only as the snapshot and today's facts say, and never
-- changes. EARNED: the deal is BOOKED, of that dealer and loan; amounts from
-- its snapshot, VAT at today's rate if the dealer is a vendor now, the
-- tenant's clawback months now. REVERSED: the exact negatives of the same
-- deal's EARNED line (bps, VAT rate, vendor flag and months copied), once,
-- while its loan is COMPLETED (before maturity), WRITTEN_OFF (both inside
-- the window) or CANCELLED (always).
CREATE OR REPLACE FUNCTION "guardDealerCommissionLine"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  deal RECORD;
  earned RECORD;
  vendor BOOLEAN;
  months INTEGER;
  vat_rate NUMERIC;
  loan_status TEXT;
  maturity DATE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A commission line is immutable: a correction is a new line';
  END IF;

  IF NEW."kind" = 'EARNED' THEN
    SELECT d.* INTO deal FROM "AssetFinanceDeal" d WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";
    IF NOT FOUND OR deal."status" <> 'BOOKED' OR deal."dealerId" IS DISTINCT FROM NEW."dealerId" OR deal."loanId" IS DISTINCT FROM NEW."loanId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An EARNED commission line is written for a booked deal of that dealer and loan';
    END IF;
    SELECT d."vatVendor" INTO vendor FROM "Dealer" d WHERE d."id" = NEW."dealerId" AND d."tenantId" = NEW."tenantId";
    SELECT c."dealerCommissionClawbackMonths" INTO months FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
    vat_rate := "dealerCommissionVatRateOn"(today);
    IF NEW."effectiveOn" IS DISTINCT FROM today
      OR NEW."baseCents" IS DISTINCT FROM deal."dealerCommissionBaseCents"
      OR NEW."bps" IS DISTINCT FROM deal."dealerCommissionBps"
      OR NEW."flatCents" IS DISTINCT FROM deal."dealerCommissionFlatCents"
      OR NEW."netCents" IS DISTINCT FROM "dealerCommissionNetCents"(NEW."baseCents", NEW."bps", NEW."flatCents")
      OR NEW."vatRate" IS DISTINCT FROM vat_rate
      OR NEW."dealerVatVendor" IS DISTINCT FROM vendor
      OR NEW."vatCents" IS DISTINCT FROM "dealerCommissionVatCents"(NEW."netCents", vat_rate, vendor)
      OR NEW."grossCents" IS DISTINCT FROM NEW."netCents" + NEW."vatCents"
      OR NEW."clawbackMonths" IS DISTINCT FROM COALESCE(months, 0) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A commission line''s amounts are the snapshot''s, at today''s VAT rate and the dealer''s VAT status';
    END IF;
    RETURN NEW;
  END IF;

  SELECT e.* INTO earned FROM "DealerCommissionLine" e WHERE e."id" = NEW."reversesLineId" AND e."tenantId" = NEW."tenantId";
  IF NOT FOUND OR earned."kind" <> 'EARNED' OR earned."dealId" IS DISTINCT FROM NEW."dealId"
    OR earned."dealerId" IS DISTINCT FROM NEW."dealerId" OR earned."loanId" IS DISTINCT FROM NEW."loanId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A REVERSED line reverses its own deal''s EARNED line';
  END IF;
  IF EXISTS (SELECT 1 FROM "DealerCommissionLine" r WHERE r."reversesLineId" = earned."id") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A commission line is reversed once';
  END IF;
  IF NEW."effectiveOn" IS DISTINCT FROM today
    OR NEW."baseCents" IS DISTINCT FROM -earned."baseCents" OR NEW."bps" IS DISTINCT FROM earned."bps"
    OR NEW."flatCents" IS DISTINCT FROM -earned."flatCents" OR NEW."netCents" IS DISTINCT FROM -earned."netCents"
    OR NEW."vatRate" IS DISTINCT FROM earned."vatRate" OR NEW."vatCents" IS DISTINCT FROM -earned."vatCents"
    OR NEW."grossCents" IS DISTINCT FROM -earned."grossCents" OR NEW."dealerVatVendor" IS DISTINCT FROM earned."dealerVatVendor"
    OR NEW."clawbackMonths" IS DISTINCT FROM earned."clawbackMonths" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A reversal''s amounts are the exact negatives of the EARNED line, dated today';
  END IF;
  SELECT l."status"::TEXT, (l."maturityDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO loan_status, maturity
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  IF loan_status IS NULL OR loan_status NOT IN ('COMPLETED', 'WRITTEN_OFF', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A commission line is reversed only when its loan is settled, written off or cancelled';
  END IF;
  IF NEW."reason"::TEXT IS DISTINCT FROM (CASE loan_status
      WHEN 'COMPLETED' THEN 'LOAN_SETTLED_EARLY' WHEN 'WRITTEN_OFF' THEN 'LOAN_WRITTEN_OFF' ELSE 'LOAN_CANCELLED' END) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The reversal reason is the loan''s status';
  END IF;
  IF loan_status <> 'CANCELLED' THEN
    IF NOT (earned."clawbackMonths" > 0 AND today < (earned."effectiveOn" + make_interval(months => earned."clawbackMonths"))::date) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The loan left the book outside the clawback window: the commission stands';
    END IF;
    IF loan_status = 'COMPLETED' AND NOT (today < maturity) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Commission is clawed back only for a loan settled before its maturity';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerCommissionLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerCommissionLine"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerCommissionLine"();
CREATE TRIGGER "DealerCommissionLine_no_truncate" BEFORE TRUNCATE ON "DealerCommissionLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerCommissionLine"();

-- Accrual: the EARNED line, written when a dealer deal moves into BOOKED.
-- Both booking paths (booking.ts, lease-booking.ts) set BOOKED and loanId in
-- one UPDATE, so this covers them and any later path. A zero commission
-- writes nothing.
CREATE OR REPLACE FUNCTION "accrueDealerCommission"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  net INTEGER;
  vat INTEGER;
  vendor BOOLEAN;
  vat_rate NUMERIC;
  months INTEGER;
BEGIN
  IF NEW."status" <> 'BOOKED' OR NEW."dealerId" IS NULL OR (TG_OP = 'UPDATE' AND OLD."status" = 'BOOKED') THEN
    RETURN NULL;
  END IF;
  IF NEW."dealerCommissionSource" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal is booked only with the commission snapshot of its approval';
  END IF;
  net := "dealerCommissionNetCents"(NEW."dealerCommissionBaseCents", NEW."dealerCommissionBps", NEW."dealerCommissionFlatCents");
  IF net <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT d."vatVendor" INTO vendor FROM "Dealer" d WHERE d."id" = NEW."dealerId" AND d."tenantId" = NEW."tenantId";
  SELECT c."dealerCommissionClawbackMonths" INTO months FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
  vat_rate := "dealerCommissionVatRateOn"(today);
  vat := "dealerCommissionVatCents"(net, vat_rate, vendor);
  INSERT INTO "DealerCommissionLine" ("id", "tenantId", "dealerId", "dealId", "loanId", "kind", "effectiveOn", "baseCents", "bps",
    "flatCents", "netCents", "vatRate", "vatCents", "grossCents", "dealerVatVendor", "clawbackMonths")
  VALUES ('dcl_' || replace(gen_random_uuid()::TEXT, '-', ''), NEW."tenantId", NEW."dealerId", NEW."id", NEW."loanId", 'EARNED', today,
    NEW."dealerCommissionBaseCents", NEW."dealerCommissionBps", NEW."dealerCommissionFlatCents", net, vat_rate, vat, net + vat, vendor,
    COALESCE(months, 0));
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_accrue_dealer_commission" AFTER INSERT OR UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION "accrueDealerCommission"();

-- Clawback: when a loan moves into COMPLETED, WRITTEN_OFF or CANCELLED, each
-- unreversed EARNED line on it is reversed by a new negative line: always for
-- CANCELLED (the contract was unwound); for WRITTEN_OFF, and for COMPLETED
-- before maturity, only inside the line's clawback window. A loan reopened
-- COMPLETED -> ACTIVE keeps its reversal (SLICE5.md, known limitation).
CREATE OR REPLACE FUNCTION "clawbackDealerCommission"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  maturity DATE := (NEW."maturityDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date;
  earned RECORD;
  why "DealerCommissionReversalReason";
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" NOT IN ('COMPLETED', 'WRITTEN_OFF', 'CANCELLED') THEN
    RETURN NULL;
  END IF;
  FOR earned IN
    SELECT e.* FROM "DealerCommissionLine" e
    WHERE e."tenantId" = NEW."tenantId" AND e."loanId" = NEW."id" AND e."kind" = 'EARNED'
      AND NOT EXISTS (SELECT 1 FROM "DealerCommissionLine" r WHERE r."reversesLineId" = e."id")
  LOOP
    why := NULL;
    IF NEW."status" = 'CANCELLED' THEN
      why := 'LOAN_CANCELLED';
    ELSIF earned."clawbackMonths" > 0 AND today < (earned."effectiveOn" + make_interval(months => earned."clawbackMonths"))::date THEN
      IF NEW."status" = 'WRITTEN_OFF' THEN
        why := 'LOAN_WRITTEN_OFF';
      ELSIF today < maturity THEN
        why := 'LOAN_SETTLED_EARLY';
      END IF;
    END IF;
    IF why IS NOT NULL THEN
      INSERT INTO "DealerCommissionLine" ("id", "tenantId", "dealerId", "dealId", "loanId", "kind", "reversesLineId", "reason", "effectiveOn",
        "baseCents", "bps", "flatCents", "netCents", "vatRate", "vatCents", "grossCents", "dealerVatVendor", "clawbackMonths")
      VALUES ('dcl_' || replace(gen_random_uuid()::TEXT, '-', ''), earned."tenantId", earned."dealerId", earned."dealId", earned."loanId",
        'REVERSED', earned."id", why, today, -earned."baseCents", earned."bps", -earned."flatCents", -earned."netCents", earned."vatRate",
        -earned."vatCents", -earned."grossCents", earned."dealerVatVendor", earned."clawbackMonths");
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "Loan_dealer_commission_clawback" AFTER UPDATE OF "status" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION "clawbackDealerCommission"();

-- Dealer bank accounts: copies of the supplier rules (20261013110500), and
-- never deleted (a run names its account). --------------------------------

ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_four_eyes" CHECK ("decidedById" IS NULL OR lower(btrim("decidedById")) <> lower(btrim("requestedById")));
ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_decision_complete" CHECK (
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "avsResult" IS NULL AND "avsPassed" IS NULL)
  OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND length(btrim("decidedById")) > 0 AND "decidedAt" IS NOT NULL)
);
ALTER TABLE "DealerBankAccount" ADD CONSTRAINT "DealerBankAccount_approval_evidence" CHECK ("status" NOT IN ('APPROVED', 'SUPERSEDED') OR "avsResult" IS NOT NULL);
CREATE UNIQUE INDEX "DealerBankAccount_one_approved_per_dealer" ON "DealerBankAccount" ("tenantId", "dealerId") WHERE "status" = 'APPROVED';

CREATE OR REPLACE FUNCTION "guardDealerBankAccount"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer bank account is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer bank account is created PENDING and approved by a second user';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."dealerId" IS DISTINCT FROM OLD."dealerId"
    OR NEW."bankName" IS DISTINCT FROM OLD."bankName" OR NEW."branchCode" IS DISTINCT FROM OLD."branchCode"
    OR NEW."accountNumber" IS DISTINCT FROM OLD."accountNumber" OR NEW."accountHolder" IS DISTINCT FROM OLD."accountHolder"
    OR NEW."accountType" IS DISTINCT FROM OLD."accountType" OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer bank account''s details are fixed; request a new account instead';
  END IF;
  IF OLD."status" = 'PENDING' THEN
    IF NEW."status" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A PENDING dealer bank account is approved or rejected, never superseded';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."decidedById" IS DISTINCT FROM OLD."decidedById" OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
    OR NEW."avsResult" IS DISTINCT FROM OLD."avsResult" OR NEW."avsPassed" IS DISTINCT FROM OLD."avsPassed"
    OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A decided dealer bank account is frozen; only APPROVED may become SUPERSEDED';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerBankAccount_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerBankAccount"();
CREATE TRIGGER "DealerBankAccount_no_truncate" BEFORE TRUNCATE ON "DealerBankAccount"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerBankAccount"();

-- Payable runs -------------------------------------------------------------

ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_status_shape" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "releaseReference" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "releaseReference" IS NULL AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'RELEASED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL
    AND "releaseReference" IS NOT NULL AND length(btrim("releaseReference")) > 0 AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'CANCELLED' AND ("approvedById" IS NULL) = ("approvedAt" IS NULL) AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "releaseReference" IS NULL AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
);
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_four_eyes" CHECK ("approvedById" IS NULL OR "approvedById" <> "createdById");
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_totals" CHECK (
  "totalGrossCents" = "totalNetCents" + "totalVatCents" AND "totalGrossCents" > 0 AND "totalNetCents" > 0
);
CREATE UNIQUE INDEX "DealerPayableRun_one_live_per_period" ON "DealerPayableRun" ("tenantId", "dealerId", "periodEnd") WHERE "status" <> 'CANCELLED';
-- One live run per line: a line is paid once.
CREATE UNIQUE INDEX "DealerPayableRunLine_one_live_run_per_line" ON "DealerPayableRunLine" ("tenantId", "lineId") WHERE NOT "voided";

-- The dealer's account, APPROVED now (locked against a concurrent decision).
CREATE OR REPLACE FUNCTION "dealerBankAccountPayable"(p_tenant TEXT, p_dealer TEXT, p_account TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1 FROM "DealerBankAccount" a
  WHERE a."id" = p_account AND a."tenantId" = p_tenant AND a."dealerId" = p_dealer AND a."status" = 'APPROVED'
  FOR SHARE;
  RETURN FOUND;
END;
$function$;

-- PENDING_APPROVAL -> APPROVED (at least one live line, totals equal to them,
-- account still APPROVED; four eyes by CHECK) -> RELEASED (account still
-- APPROVED: a superseded or rejected one refuses; cancel and recreate);
-- PENDING_APPROVAL or APPROVED -> CANCELLED. Released and cancelled runs and
-- every key and total are fixed; nothing is deleted.
CREATE OR REPLACE FUNCTION "guardDealerPayableRun"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  sums RECORD;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run is never deleted: cancel it';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run is created PENDING_APPROVAL';
    END IF;
    IF NEW."periodEnd" > (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run covers a period that has ended';
    END IF;
    IF NOT "dealerBankAccountPayable"(NEW."tenantId", NEW."dealerId", NEW."bankAccountId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run pays the dealer''s APPROVED bank account';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('RELEASED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A released or cancelled payable run never changes';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."dealerId" IS DISTINCT FROM OLD."dealerId"
    OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd" OR NEW."bankAccountId" IS DISTINCT FROM OLD."bankAccountId"
    OR NEW."totalNetCents" IS DISTINCT FROM OLD."totalNetCents" OR NEW."totalVatCents" IS DISTINCT FROM OLD."totalVatCents"
    OR NEW."totalGrossCents" IS DISTINCT FROM OLD."totalGrossCents" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR (OLD."status" = 'APPROVED' AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run''s dealer, period, account, totals, creator and approval are fixed';
  END IF;
  IF NEW."status" = OLD."status" THEN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run changes only by moving on';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'CANCELLED' THEN
    IF NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cancelling a payable run records who cancelled it and when, and changes nothing else';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED') OR (OLD."status" = 'APPROVED' AND NEW."status" = 'RELEASED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run moves PENDING_APPROVAL -> APPROVED -> RELEASED, or is cancelled';
  END IF;
  IF NOT "dealerBankAccountPayable"(NEW."tenantId", NEW."dealerId", NEW."bankAccountId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run pays the dealer''s APPROVED bank account';
  END IF;
  IF NEW."status" = 'APPROVED' THEN
    SELECT count(*) AS n, COALESCE(sum(l."netCents"), 0) AS net, COALESCE(sum(l."vatCents"), 0) AS vat,
        COALESCE(sum(l."grossCents"), 0) AS gross
      INTO sums
      FROM "DealerPayableRunLine" k JOIN "DealerCommissionLine" l ON l."id" = k."lineId" AND l."tenantId" = k."tenantId"
      WHERE k."runId" = NEW."id" AND k."tenantId" = NEW."tenantId" AND NOT k."voided";
    IF sums.n = 0 OR sums.net <> NEW."totalNetCents" OR sums.vat <> NEW."totalVatCents" OR sums.gross <> NEW."totalGrossCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run is approved with at least one line and totals equal to them';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerPayableRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerPayableRun"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerPayableRun"();
CREATE TRIGGER "DealerPayableRun_no_truncate" BEFORE TRUNCATE ON "DealerPayableRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerPayableRun"();

-- A cancelled run frees its lines for a later run.
CREATE OR REPLACE FUNCTION "voidDealerPayableRunLines"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED' THEN
    UPDATE "DealerPayableRunLine" SET "voided" = true WHERE "runId" = NEW."id" AND "tenantId" = NEW."tenantId" AND NOT "voided";
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "DealerPayableRun_void_lines_on_cancel" AFTER UPDATE OF "status" ON "DealerPayableRun"
  FOR EACH ROW EXECUTE FUNCTION "voidDealerPayableRunLines"();

-- A line joins a run only while the run awaits approval (the run row is
-- locked, so an approval cannot race it), and only the run's dealer's line
-- earned by its period end. The only change is voided false -> true while the
-- run is CANCELLED.
CREATE OR REPLACE FUNCTION "guardDealerPayableRunLine"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  run RECORD;
  line RECORD;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A run''s line is never deleted: cancel the run';
  END IF;
  SELECT r.* INTO run FROM "DealerPayableRun" r WHERE r."id" = NEW."runId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND OR run."status" <> 'PENDING_APPROVAL' OR NEW."voided" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A line joins a run only while the run awaits approval';
    END IF;
    SELECT l.* INTO line FROM "DealerCommissionLine" l WHERE l."id" = NEW."lineId" AND l."tenantId" = NEW."tenantId";
    IF NOT FOUND OR line."dealerId" <> run."dealerId" OR line."effectiveOn" > run."periodEnd" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A run holds its dealer''s lines earned by its period end';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD."voided" = false AND NEW."voided" = true AND run."status" = 'CANCELLED'
    AND (to_jsonb(NEW) - 'voided') = (to_jsonb(OLD) - 'voided')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A run''s line is only voided, when its run is cancelled';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerPayableRunLine_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerPayableRunLine"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerPayableRunLine"();
CREATE TRIGGER "DealerPayableRunLine_no_truncate" BEFORE TRUNCATE ON "DealerPayableRunLine"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerPayableRunLine"();

-- Dealer consent and document requests -------------------------------------

ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_verification_complete" CHECK (("verifiedById" IS NULL) = ("verifiedAt" IS NULL));

-- Evidence, not consent: the dealer's own POPIA_CONSENT upload on this deal,
-- about the deal's client or an active person of its entity, attested by an
-- active user of the deal's dealer. A staff member adds the verification
-- once (lib/consent.ts then records ClientConsent). Never deleted.
CREATE OR REPLACE FUNCTION "guardDealerConsentAttestation"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal RECORD;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer consent attestation is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."verifiedById" IS NOT NULL OR OLD."verifiedAt" IS NOT NULL
      OR (to_jsonb(NEW) - 'verifiedById' - 'verifiedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'verifiedById' - 'verifiedAt') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only the staff verification is added to a consent attestation, once';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."verifiedById" IS NOT NULL OR NEW."verifiedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A consent attestation is verified by staff after it is made';
  END IF;
  SELECT d.* INTO deal FROM "AssetFinanceDeal" d WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";
  IF NOT FOUND OR deal."dealerId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer consent attestation is made on a dealer deal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "EntityDocument" doc
    JOIN "DealerUser" uploader ON uploader."id" = doc."uploadedById" AND uploader."tenantId" = doc."tenantId" AND uploader."dealerId" = deal."dealerId"
    WHERE doc."id" = NEW."documentId" AND doc."tenantId" = NEW."tenantId" AND doc."dealId" = NEW."dealId"
      AND doc."docType" = 'POPIA_CONSENT' AND doc."uploadedByType" = 'dealer' AND doc."deletedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer consent attestation cites the deal''s POPIA consent document the dealer uploaded';
  END IF;
  IF NOT (
    (deal."clientId" IS NOT NULL AND NEW."clientId" = deal."clientId")
    OR (deal."entityId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "EntityRelationship" r
      WHERE r."tenantId" = NEW."tenantId" AND r."entityId" = deal."entityId" AND r."clientId" = NEW."clientId" AND r."active"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The consent''s subject is the deal''s client or an active person of its entity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "DealerUser" u
    WHERE u."id" = NEW."dealerUserId" AND u."tenantId" = NEW."tenantId" AND u."dealerId" = deal."dealerId" AND u."active"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The attesting user belongs to the deal''s dealer';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerConsentAttestation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerConsentAttestation"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerConsentAttestation"();
CREATE TRIGGER "DealerConsentAttestation_no_truncate" BEFORE TRUNCATE ON "DealerConsentAttestation"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerConsentAttestation"();

ALTER TABLE "DealerDocumentRequest" ADD CONSTRAINT "DealerDocumentRequest_note_length" CHECK (char_length(btrim("note")) BETWEEN 1 AND 500);
ALTER TABLE "DealerDocumentRequest" ADD CONSTRAINT "DealerDocumentRequest_fulfilment_complete" CHECK (("fulfilledDocumentId" IS NULL) = ("fulfilledAt" IS NULL));

-- Made on a dealer deal, unfulfilled; fulfilled once by a live document of
-- the same deal and type; nothing else changes; never deleted.
CREATE OR REPLACE FUNCTION "guardDealerDocumentRequest"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document request is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."fulfilledDocumentId" IS NOT NULL OR NEW."fulfilledAt" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" d WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId" AND d."dealerId" IS NOT NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document request is made on a dealer deal, unfulfilled';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."fulfilledDocumentId" IS NOT NULL OR OLD."fulfilledAt" IS NOT NULL
    OR (to_jsonb(NEW) - 'fulfilledDocumentId' - 'fulfilledAt') IS DISTINCT FROM (to_jsonb(OLD) - 'fulfilledDocumentId' - 'fulfilledAt')
    OR NOT EXISTS (
      SELECT 1 FROM "EntityDocument" doc
      WHERE doc."id" = NEW."fulfilledDocumentId" AND doc."tenantId" = NEW."tenantId" AND doc."dealId" = NEW."dealId"
        AND doc."docType" = NEW."docType" AND doc."deletedAt" IS NULL
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A document request is fulfilled once, by a live document of its deal and type; nothing else changes';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerDocumentRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerDocumentRequest"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerDocumentRequest"();
CREATE TRIGGER "DealerDocumentRequest_no_truncate" BEFORE TRUNCATE ON "DealerDocumentRequest"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerDocumentRequest"();

-- Row-level security: the same policy as 20261015130000_tenant_rls_new_scoped_models
-- on every new model (lib/registry/tenant-scoped-models/240-dealer-portal.ts).
ALTER TABLE "Dealer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dealer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "Dealer" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerUser" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerUser" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerUser" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerCommissionRate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerCommissionRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerCommissionRate" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerCommissionLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerCommissionLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerCommissionLine" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerPayableRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerPayableRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerPayableRun" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerPayableRunLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerPayableRunLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerPayableRunLine" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerBankAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerBankAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerBankAccount" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerConsentAttestation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerConsentAttestation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerConsentAttestation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "DealerDocumentRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerDocumentRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerDocumentRequest" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
