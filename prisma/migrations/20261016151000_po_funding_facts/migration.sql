-- PO funding facts (Fair Score audit): the purchase order a PO_FUNDING
-- application funds. Additive and nullable; the portal requires them for that
-- product (lib/applications/po-funding.ts).

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "poBuyerName" TEXT,
ADD COLUMN     "poDocumentId" TEXT,
ADD COLUMN     "poNumber" TEXT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_poDocumentId_fkey" FOREIGN KEY ("tenantId", "poDocumentId") REFERENCES "ClientDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

