CREATE UNIQUE INDEX "ContractRate_tenantId_loanId_id_key" ON "ContractRate" ("tenantId", "loanId", "id");
CREATE TABLE "AssetFinanceRateNotice" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "contractRateId" TEXT NOT NULL,
  "loanReference" TEXT NOT NULL,
  "effectiveDate" DATE NOT NULL,
  "firstChangedPaymentDate" DATE NOT NULL,
  "resultingRate" DECIMAL(9,6) NOT NULL,
  "oldInstalmentCents" INTEGER NOT NULL,
  "newInstalmentCents" INTEGER NOT NULL,
  "historicalBalanceAdjustmentCents" INTEGER NOT NULL DEFAULT 0,
  "correctionPendingManual" BOOLEAN NOT NULL DEFAULT false,
  "totalInterestCents" INTEGER NOT NULL,
  "monthlyInterestCents" INTEGER NOT NULL,
  "recipientClientIds" TEXT[],
  "lastOutcomes" JSONB,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssetFinanceRateNotice_tenantId_loanId_contractRateId_fkey" FOREIGN KEY ("tenantId", "loanId", "contractRateId") REFERENCES "ContractRate" ("tenantId", "loanId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AssetFinanceRateNotice_contractRateId_key" ON "AssetFinanceRateNotice" ("contractRateId");
CREATE INDEX "AssetFinanceRateNotice_tenantId_completedAt_createdAt_idx" ON "AssetFinanceRateNotice" ("tenantId", "completedAt", "createdAt");

CREATE UNIQUE INDEX "AssetFinanceRateNotice_tenantId_loanId_contractRateId_key" ON "AssetFinanceRateNotice" ("tenantId", "loanId", "contractRateId");

ALTER TABLE "AssetFinanceRateNotice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetFinanceRateNotice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetFinanceRateNotice"
USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant())
WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
