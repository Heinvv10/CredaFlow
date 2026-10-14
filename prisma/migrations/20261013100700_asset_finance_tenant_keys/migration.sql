-- Tenant-bind the asset-finance references: a contract rate, a tax invoice and
-- a credit note can only point at a row of their own tenant (composite FKs).

-- DropForeignKey
ALTER TABLE "ContractRate" DROP CONSTRAINT "ContractRate_loanId_fkey";

-- DropForeignKey
ALTER TABLE "CreditNote" DROP CONSTRAINT "CreditNote_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "TaxInvoice" DROP CONSTRAINT "TaxInvoice_loanId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Loan_tenantId_id_key" ON "Loan"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_tenantId_id_key" ON "TaxInvoice"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

