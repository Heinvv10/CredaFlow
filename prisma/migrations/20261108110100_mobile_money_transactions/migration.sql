-- M-Pesa repayments (lib/mobile-money, KE-4): one row per transaction a provider
-- reported (a paybill C2B payment) or per STK push a borrower started. Money is
-- booked only through applyManualReceipt; this row names the receipt it became.
-- A new table: nothing the running code writes is refused.
--
-- Rollback (hand-written; Prisma has no down migrations):
--   BEGIN;
--   DROP TABLE "MobileMoneyTransaction";
--   DROP TYPE "MobileMoneyTransactionStatus";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261108110100_mobile_money_transactions';
--   COMMIT;

-- CreateEnum
CREATE TYPE "MobileMoneyTransactionStatus" AS ENUM ('PENDING', 'CANCELLED', 'BOOKED', 'HELD', 'UNMATCHED', 'NEEDS_REVIEW');

-- CreateTable
CREATE TABLE "MobileMoneyTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "transId" TEXT,
    "checkoutRequestId" TEXT,
    "msisdnLast4" TEXT,
    "billRef" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "MobileMoneyTransactionStatus" NOT NULL,
    "transactedAt" TIMESTAMP(3),
    "loanId" TEXT,
    "paymentId" TEXT,
    "reviewReason" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileMoneyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileMoneyTransaction_tenantId_status_idx" ON "MobileMoneyTransaction"("tenantId", "status");

-- CreateIndex
CREATE INDEX "MobileMoneyTransaction_loanId_idx" ON "MobileMoneyTransaction"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileMoneyTransaction_provider_transId_key" ON "MobileMoneyTransaction"("provider", "transId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileMoneyTransaction_provider_checkoutRequestId_key" ON "MobileMoneyTransaction"("provider", "checkoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "MobileMoneyTransaction_tenantId_id_key" ON "MobileMoneyTransaction"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MobileMoneyTransaction_tenantId_paymentId_key" ON "MobileMoneyTransaction"("tenantId", "paymentId");

-- AddForeignKey
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written. The amount is a positive number of cents. Only the last four
-- digits of the payer's phone are ever stored. The status says what happened,
-- and the columns must agree: a PENDING push has no transaction yet; a booked
-- or held one names its loan and receipt; an unmatched one names neither; one
-- waiting for a person says why.
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_msisdn_last4" CHECK ("msisdnLast4" IS NULL OR "msisdnLast4" ~ '^[0-9]{4}$');
ALTER TABLE "MobileMoneyTransaction" ADD CONSTRAINT "MobileMoneyTransaction_status_consistent" CHECK (
  (
    "status" = 'PENDING'::"MobileMoneyTransactionStatus"
    AND "checkoutRequestId" IS NOT NULL AND "transId" IS NULL AND "loanId" IS NOT NULL AND "paymentId" IS NULL
  ) OR (
    "status" = 'CANCELLED'::"MobileMoneyTransactionStatus"
    AND "checkoutRequestId" IS NOT NULL AND "transId" IS NULL AND "paymentId" IS NULL
  ) OR (
    "status" IN ('BOOKED'::"MobileMoneyTransactionStatus", 'HELD'::"MobileMoneyTransactionStatus")
    AND "transId" IS NOT NULL AND "loanId" IS NOT NULL AND "paymentId" IS NOT NULL
  ) OR (
    "status" = 'UNMATCHED'::"MobileMoneyTransactionStatus"
    AND "transId" IS NOT NULL AND "loanId" IS NULL AND "paymentId" IS NULL
  ) OR (
    "status" = 'NEEDS_REVIEW'::"MobileMoneyTransactionStatus"
    AND "transId" IS NOT NULL AND "paymentId" IS NULL
    AND "reviewReason" IS NOT NULL AND LENGTH(BTRIM("reviewReason")) > 0
  )
);

-- Same tenant-isolation policy as every other TENANT_SCOPED_MODELS table
-- (20261015130000_tenant_rls_new_scoped_models).
ALTER TABLE "MobileMoneyTransaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MobileMoneyTransaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "MobileMoneyTransaction" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
