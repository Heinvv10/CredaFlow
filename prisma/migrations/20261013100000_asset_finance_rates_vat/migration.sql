-- CreateEnum
CREATE TYPE "ReferenceRateBasis" AS ENUM ('FIXED', 'PRIME', 'REPO', 'JIBAR', 'ZARONIA', 'LENDER_BASE');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('TAX_INVOICE', 'CREDIT_NOTE');

-- CreateTable
CREATE TABLE "ReferenceRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "basis" "ReferenceRateBasis" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "basis" "ReferenceRateBasis" NOT NULL,
    "margin" DECIMAL(9,6),
    "fixedRate" DECIMAL(9,6),
    "resultingRate" DECIMAL(9,6) NOT NULL,
    "newInstalmentCents" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vatNumber" TEXT NOT NULL,
    "registeredName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VatConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatRate" (
    "id" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "rate" DECIMAL(6,4) NOT NULL,

    CONSTRAINT "VatRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDocumentCounter" (
    "tenantId" TEXT NOT NULL,
    "kind" "TaxDocumentKind" NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TaxDocumentCounter_pkey" PRIMARY KEY ("tenantId","kind")
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "supplyDate" DATE NOT NULL,
    "loanId" TEXT,
    "supplierName" TEXT NOT NULL,
    "supplierAddress" TEXT NOT NULL,
    "supplierVatNumber" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientVatNumber" TEXT,
    "vatRate" DECIMAL(6,4) NOT NULL,
    "totalExclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "totalInclVatCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitExclVatCents" INTEGER NOT NULL,
    "exclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "inclVatCents" INTEGER NOT NULL,

    CONSTRAINT "TaxInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "exclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "inclVatCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceRate_tenantId_basis_effectiveDate_key" ON "ReferenceRate"("tenantId", "basis", "effectiveDate");

-- CreateIndex
CREATE INDEX "ContractRate_tenantId_idx" ON "ContractRate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractRate_loanId_effectiveDate_key" ON "ContractRate"("loanId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "VatConfig_tenantId_key" ON "VatConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VatRate_effectiveDate_key" ON "VatRate"("effectiveDate");

-- CreateIndex
CREATE INDEX "TaxInvoice_loanId_idx" ON "TaxInvoice"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_tenantId_number_key" ON "TaxInvoice"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoiceLine_invoiceId_lineNo_key" ON "TaxInvoiceLine"("invoiceId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_tenantId_number_key" ON "CreditNote"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatConfig" ADD CONSTRAINT "VatConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDocumentCounter" ADD CONSTRAINT "TaxDocumentCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

