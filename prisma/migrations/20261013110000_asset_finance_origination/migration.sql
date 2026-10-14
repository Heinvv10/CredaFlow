-- CreateEnum
CREATE TYPE "EntityDocumentType" AS ENUM ('CIPC_REGISTRATION', 'TRUST_DEED', 'LETTERS_OF_AUTHORITY', 'RESOLUTION', 'AFS', 'MANAGEMENT_ACCOUNTS', 'BANK_STATEMENT', 'SUPPLIER_INVOICE', 'INSURANCE_NOTING', 'TRACKER_CERTIFICATE', 'DELIVERY_ACCEPTANCE', 'NATIS_DOCUMENT', 'VALUATION', 'SIGNED_AGREEMENT', 'SIGNED_SURETYSHIP', 'SIGNED_RESOLUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('PASSENGER_VEHICLE', 'LIGHT_COMMERCIAL', 'TRUCK', 'TRAILER', 'TRACTOR', 'TLB', 'EXCAVATOR', 'GRADER', 'FRONT_END_LOADER', 'FORKLIFT', 'OTHER_YELLOW');

-- CreateEnum
CREATE TYPE "ValuationSource" AS ENUM ('DEALER', 'AUCTIONEER', 'ASSESSOR', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SupplierBankAccountStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AssetDealStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REFUSED_NCA', 'APPROVED', 'DECLINED', 'REFERRED', 'CONTRACTED', 'BOOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreditDecision" AS ENUM ('APPROVE', 'DECLINE', 'REFER');

-- CreateEnum
CREATE TYPE "DealSignerRole" AS ENUM ('AUTHORISED_SIGNATORY', 'SURETY');

-- CreateEnum
CREATE TYPE "DealDocumentKind" AS ENUM ('AGREEMENT', 'SURETYSHIP', 'RESOLUTION');

-- CreateEnum
CREATE TYPE "SignatureMethod" AS ENUM ('E_SIGN', 'WET_INK');

-- CreateEnum
CREATE TYPE "PayoutChecklistItemKind" AS ENUM ('SIGNED_AGREEMENT', 'SIGNED_SURETYSHIPS', 'SIGNED_RESOLUTION', 'SUPPLIER_INVOICE_MATCHES_ASSET', 'SUPPLIER_BANK_VERIFIED', 'INSURANCE_NOTES_LENDER', 'TRACKER_CONFIRMED', 'DELIVERY_AND_ACCEPTANCE', 'NATIS_TITLEHOLDER');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'RELEASED');

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "nonNcaCollectionFeeCents" INTEGER,
ADD COLUMN     "nonNcaDefaultInterestMargin" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "assetFinanceLegalWordingApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assetPayoutDualApprovalCents" INTEGER NOT NULL DEFAULT 100000000;

-- CreateTable
CREATE TABLE "EntityDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "dealId" TEXT,
    "docType" "EntityDocumentType" NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "uploadedByType" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancedAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetClass" "AssetClass" NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "vin" TEXT,
    "engineNumber" TEXT,
    "registrationNumber" TEXT,
    "hours" INTEGER,
    "odometerKm" INTEGER,
    "cashPriceExclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "residualCents" INTEGER,
    "natisTitleholder" TEXT,
    "trackerProvider" TEXT,
    "trackerId" TEXT,
    "insurer" TEXT,
    "policyNumber" TEXT,
    "lenderNotedConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetValuation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "valuedOn" DATE NOT NULL,
    "source" "ValuationSource" NOT NULL,
    "valuerName" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "documentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "vatNumber" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierBankAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "accountType" TEXT,
    "status" "SupplierBankAccountStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "avsResult" JSONB,
    "avsPassed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetFinanceDeal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "loanId" TEXT,
    "contractType" "ContractType" NOT NULL DEFAULT 'INSTALMENT_SALE',
    "status" "AssetDealStatus" NOT NULL DEFAULT 'DRAFT',
    "depositCents" INTEGER NOT NULL DEFAULT 0,
    "tradeInCents" INTEGER NOT NULL DEFAULT 0,
    "financedFeesCents" INTEGER NOT NULL DEFAULT 0,
    "balloonCents" INTEGER NOT NULL DEFAULT 0,
    "weights" JSONB NOT NULL,
    "structurePreset" TEXT NOT NULL,
    "firstDueDate" DATE NOT NULL,
    "vatDeferralPeriodIndex" INTEGER,
    "rateBasis" "ReferenceRateBasis" NOT NULL,
    "rateMargin" DECIMAL(9,6),
    "fixedRate" DECIMAL(9,6),
    "baseInstalmentCents" INTEGER,
    "decision" "CreditDecision",
    "decisionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetFinanceDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityFinancials" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "turnoverCents" INTEGER NOT NULL,
    "ebitdaCents" INTEGER NOT NULL,
    "totalAssetsCents" INTEGER NOT NULL,
    "totalLiabilitiesCents" INTEGER NOT NULL,
    "existingDebtServiceCents" INTEGER NOT NULL,
    "avgMonthlyCreditsCents" INTEGER NOT NULL,
    "returnedDebitsCount" INTEGER NOT NULL,
    "dscr" DECIMAL(9,4),
    "gearing" DECIMAL(9,4),
    "notes" TEXT,
    "preparedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityFinancials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSigner" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" "DealSignerRole" NOT NULL,
    "document" "DealDocumentKind" NOT NULL,
    "documentSha256" TEXT,
    "method" "SignatureMethod",
    "signedAt" TIMESTAMP(3),
    "signatureData" TEXT,
    "signatureSha256" TEXT,
    "signedByIp" TEXT,
    "scanDocumentId" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealSigner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutChecklistItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "item" "PayoutChecklistItemKind" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "evidenceDocumentId" TEXT,
    "note" TEXT,

    CONSTRAINT "PayoutChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "supplierBankAccountId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntityDocument_tenantId_entityId_idx" ON "EntityDocument"("tenantId", "entityId");

-- CreateIndex
CREATE INDEX "EntityDocument_dealId_idx" ON "EntityDocument"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityDocument_tenantId_id_key" ON "EntityDocument"("tenantId", "id");

-- CreateIndex
CREATE INDEX "FinancedAsset_tenantId_idx" ON "FinancedAsset"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FinancedAsset_tenantId_id_key" ON "FinancedAsset"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AssetValuation_tenantId_assetId_idx" ON "AssetValuation"("tenantId", "assetId");

-- CreateIndex
CREATE INDEX "Supplier_tenantId_idx" ON "Supplier"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SupplierBankAccount_tenantId_supplierId_idx" ON "SupplierBankAccount"("tenantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierBankAccount_tenantId_id_key" ON "SupplierBankAccount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFinanceDeal_applicationId_key" ON "AssetFinanceDeal"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFinanceDeal_loanId_key" ON "AssetFinanceDeal"("loanId");

-- CreateIndex
CREATE INDEX "AssetFinanceDeal_tenantId_status_idx" ON "AssetFinanceDeal"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFinanceDeal_tenantId_id_key" ON "AssetFinanceDeal"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFinanceDeal_tenantId_applicationId_key" ON "AssetFinanceDeal"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFinanceDeal_tenantId_loanId_key" ON "AssetFinanceDeal"("tenantId", "loanId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityFinancials_dealId_key" ON "EntityFinancials"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityFinancials_tenantId_dealId_key" ON "EntityFinancials"("tenantId", "dealId");

-- CreateIndex
CREATE INDEX "DealSigner_tenantId_clientId_idx" ON "DealSigner"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "DealSigner_dealId_clientId_document_key" ON "DealSigner"("dealId", "clientId", "document");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutChecklistItem_dealId_item_key" ON "PayoutChecklistItem"("dealId", "item");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_dealId_key" ON "Payout"("dealId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_tenantId_dealId_key" ON "Payout"("tenantId", "dealId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EntityFinancials" ADD CONSTRAINT "EntityFinancials_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayoutChecklistItem" ADD CONSTRAINT "PayoutChecklistItem_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_supplierBankAccountId_fkey" FOREIGN KEY ("tenantId", "supplierBankAccountId") REFERENCES "SupplierBankAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

