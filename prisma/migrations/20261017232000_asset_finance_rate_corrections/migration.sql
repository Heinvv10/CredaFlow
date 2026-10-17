CREATE TABLE "AssetFinanceRateCorrection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "contractRateId" TEXT NOT NULL,
  "cause" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "cumulativeAmountCents" INTEGER NOT NULL,
  "contractualRows" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_MANUAL_EXECUTION',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetFinanceRateCorrection_status" CHECK ("status" = 'PENDING_MANUAL_EXECUTION'),
  CONSTRAINT "AssetFinanceRateCorrection_tenantId_loanId_contractRateId_fkey" FOREIGN KEY ("tenantId","loanId","contractRateId") REFERENCES "ContractRate"("tenantId","loanId","id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "AssetFinanceRateCorrection_cause_key" ON "AssetFinanceRateCorrection"("cause");
CREATE INDEX "AssetFinanceRateCorrection_tenantId_loanId_createdAt_idx" ON "AssetFinanceRateCorrection"("tenantId","loanId","createdAt");
ALTER TABLE "AssetFinanceRateCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetFinanceRateCorrection" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AssetFinanceRateCorrection" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
CREATE FUNCTION public."guardAssetFinanceRateCorrection"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rate corrections are append-only pending manual execution';
END;
$$;
CREATE TRIGGER "AssetFinanceRateCorrection_insert_only" BEFORE UPDATE OR DELETE ON "AssetFinanceRateCorrection" FOR EACH ROW EXECUTE FUNCTION public."guardAssetFinanceRateCorrection"();

CREATE FUNCTION public."validateAssetFinanceRateCorrection"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous BIGINT;
BEGIN
  SELECT COALESCE(SUM("amountCents"),0) INTO previous FROM "AssetFinanceRateCorrection" WHERE "tenantId" = NEW."tenantId" AND "loanId" = NEW."loanId";
  IF NEW."cumulativeAmountCents" <> previous + NEW."amountCents"
    OR NEW."reason" NOT IN ('LATE_CLOSED_BOOK_RATE','FIXED_NOTICE_WINDOW_RATE','RECEIPT_RECONCILIATION','APPLIED_TO_SCHEDULE','RATE_PAYOFF_CREDIT','LATE_CLOSED_LEASE_RATE')
    OR JSONB_TYPEOF(NEW."contractualRows") IS DISTINCT FROM 'object'
    OR (NEW."reason" = 'APPLIED_TO_SCHEDULE' AND NEW."cumulativeAmountCents" <> 0)
  THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rate correction must reconcile its immutable signed ledger'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AssetFinanceRateCorrection_reconcile" BEFORE INSERT ON "AssetFinanceRateCorrection" FOR EACH ROW EXECUTE FUNCTION public."validateAssetFinanceRateCorrection"();
