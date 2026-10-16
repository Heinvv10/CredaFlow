-- Client-notified payments (Fair Score audit B7): a borrower's portal "I have
-- paid" report becomes an item staff allocate or reject on the Payments page.
-- A claim, never a receipt: allocating it captures a real Payment.

-- CreateEnum
CREATE TYPE "PaymentNotificationStatus" AS ENUM ('PENDING', 'ALLOCATED', 'REJECTED');

-- CreateTable
CREATE TABLE "PaymentNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT,
    "paymentDate" TIMESTAMP(3),
    "notes" TEXT,
    "documentId" TEXT NOT NULL,
    "status" "PaymentNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentNotification_tenantId_status_idx" ON "PaymentNotification"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PaymentNotification_loanId_idx" ON "PaymentNotification"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNotification_tenantId_id_key" ON "PaymentNotification"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNotification_tenantId_paymentId_key" ON "PaymentNotification"("tenantId", "paymentId");

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_tenantId_documentId_fkey" FOREIGN KEY ("tenantId", "documentId") REFERENCES "ClientDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written. The status says what happened, and the columns must agree:
-- PENDING is unresolved; ALLOCATED names the receipt it became and who
-- allocated it; REJECTED says who rejected it and why. The claimed amount is a
-- positive number of cents.
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_resolution_consistent" CHECK (
  (
    "status" = 'PENDING'::"PaymentNotificationStatus"
    AND "paymentId" IS NULL AND "resolvedById" IS NULL AND "resolvedAt" IS NULL AND "rejectReason" IS NULL
  ) OR (
    "status" = 'ALLOCATED'::"PaymentNotificationStatus"
    AND "paymentId" IS NOT NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "rejectReason" IS NULL
  ) OR (
    "status" = 'REJECTED'::"PaymentNotificationStatus"
    AND "paymentId" IS NULL AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL
    AND "rejectReason" IS NOT NULL AND LENGTH(BTRIM("rejectReason")) > 0
  )
);

-- Same tenant-isolation policy as every other TENANT_SCOPED_MODELS table
-- (20261015130000_tenant_rls_new_scoped_models).
ALTER TABLE "PaymentNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentNotification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "PaymentNotification" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
