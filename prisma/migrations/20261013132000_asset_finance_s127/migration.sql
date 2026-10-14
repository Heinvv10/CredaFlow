CREATE TYPE "SurrenderStatus" AS ENUM ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED', 'PROCEEDS_CREDITED', 'FINAL_NOTICE_ISSUED');

CREATE TABLE "SurrenderRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "loanId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "status" "SurrenderStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedByType" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "requestedOn" DATE NOT NULL,
  "assetCondition" TEXT NOT NULL,
  "valuationDueOn" DATE NOT NULL,
  "valuationId" TEXT,
  "valuationNoticePath" TEXT,
  "valuationNoticeSha256" TEXT,
  "saleProceedsCents" INTEGER,
  "proceedsPaymentId" TEXT,
  "shortfallCents" INTEGER,
  "refundCents" INTEGER,
  "finalNoticePath" TEXT,
  "finalNoticeSha256" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SurrenderRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SurrenderRequest_requester_check" CHECK ("requestedByType" IN ('CLIENT','STAFF') AND length(btrim("requestedById")) > 0),
  CONSTRAINT "SurrenderRequest_condition_check" CHECK (length(btrim("assetCondition")) BETWEEN 3 AND 2000),
  CONSTRAINT "SurrenderRequest_dates_check" CHECK ("valuationDueOn" >= "requestedOn"),
  CONSTRAINT "SurrenderRequest_money_check" CHECK (("saleProceedsCents" IS NULL OR "saleProceedsCents" >= 0) AND ("shortfallCents" IS NULL OR "shortfallCents" >= 0) AND ("refundCents" IS NULL OR "refundCents" >= 0)),
  CONSTRAINT "SurrenderRequest_notice_check" CHECK (
    (("valuationNoticePath" IS NULL) = ("valuationNoticeSha256" IS NULL))
    AND (("finalNoticePath" IS NULL) = ("finalNoticeSha256" IS NULL))
    AND ("valuationNoticeSha256" IS NULL OR "valuationNoticeSha256" ~ '^[0-9a-f]{64}$')
    AND ("finalNoticeSha256" IS NULL OR "finalNoticeSha256" ~ '^[0-9a-f]{64}$')
  )
);
CREATE UNIQUE INDEX "SurrenderRequest_tenantId_id_key" ON "SurrenderRequest"("tenantId", "id");
CREATE UNIQUE INDEX "SurrenderRequest_valuationId_key" ON "SurrenderRequest"("valuationId");
CREATE UNIQUE INDEX "SurrenderRequest_proceedsPaymentId_key" ON "SurrenderRequest"("proceedsPaymentId");
CREATE UNIQUE INDEX "Payment_tenantId_id_key" ON "Payment"("tenantId", "id");
CREATE INDEX "SurrenderRequest_tenantId_loanId_idx" ON "SurrenderRequest"("tenantId", "loanId");
CREATE UNIQUE INDEX "SurrenderRequest_one_open_per_loan" ON "SurrenderRequest"("loanId") WHERE "status" <> 'FINAL_NOTICE_ISSUED';
ALTER TABLE "SurrenderRequest" ADD CONSTRAINT "SurrenderRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SurrenderRequest" ADD CONSTRAINT "SurrenderRequest_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SurrenderRequest" ADD CONSTRAINT "SurrenderRequest_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SurrenderRequest" ADD CONSTRAINT "SurrenderRequest_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "AssetValuation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SurrenderRequest" ADD CONSTRAINT "SurrenderRequest_tenantId_proceedsPaymentId_fkey" FOREIGN KEY ("tenantId", "proceedsPaymentId") REFERENCES "Payment"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION public."guardSurrenderRequest"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE valuation RECORD; payment RECORD; loan_row RECORD; receipt_total INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A voluntary-surrender record is never deleted'; END IF;
  SELECT l."ncaRegime", l."contractType", l."assetId", l."status", l."outstandingPrincipal", l."chargesOutstanding"
  INTO loan_row FROM "Loan" l WHERE l."id"=NEW."loanId" AND l."tenantId"=NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row."ncaRegime" <> 'NCA' OR loan_row."contractType" = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Voluntary surrender belongs to an NCA asset-finance loan and its financed asset';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'REQUESTED' OR loan_row."status" NOT IN ('ACTIVE','DEFAULTED') OR NEW."valuationId" IS NOT NULL OR NEW."valuationNoticePath" IS NOT NULL OR NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surrender opens REQUESTED on an active or defaulted NCA asset loan without later evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id",NEW."tenantId",NEW."loanId",NEW."assetId",NEW."requestedByType",NEW."requestedById",NEW."requestedOn",NEW."assetCondition",NEW."valuationDueOn")
    IS DISTINCT FROM (OLD."id",OLD."tenantId",OLD."loanId",OLD."assetId",OLD."requestedByType",OLD."requestedById",OLD."requestedOn",OLD."assetCondition",OLD."valuationDueOn") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender request and statutory deadline are immutable';
  END IF;
  IF (OLD."status",NEW."status") NOT IN (
    ('REQUESTED','VALUED'),('VALUED','VALUATION_NOTICE_ISSUED'),('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED'),('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED')
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender follows request, valuation, valuation notice, proceeds and final notice in order'; END IF;
  IF NEW."status" >= 'VALUED' THEN
    SELECT * INTO valuation FROM "AssetValuation" v WHERE v."id"=NEW."valuationId" AND v."tenantId"=NEW."tenantId" AND v."assetId"=NEW."assetId";
    IF NOT FOUND OR valuation."valuedOn" < NEW."requestedOn" OR valuation."valuedOn" > NEW."valuationDueOn" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The s127 valuation must be for this asset within the recorded statutory window';
    END IF;
  END IF;
  IF NEW."status" >= 'VALUATION_NOTICE_ISSUED' AND NEW."valuationNoticePath" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The valuation notice bytes and digest are required';
  END IF;
  IF NEW."status" >= 'PROCEEDS_CREDITED' THEN
    SELECT p."amount",p."allocationStatus",p."reversed",p."loanId" INTO payment FROM "Payment" p WHERE p."id"=NEW."proceedsPaymentId" AND p."tenantId"=NEW."tenantId";
    SELECT payment."amount" + COALESCE(sum(child."amount"),0) INTO receipt_total
    FROM "Payment" child WHERE child."parentPaymentId"=NEW."proceedsPaymentId" AND NOT child."reversed";
    IF NOT FOUND OR payment."loanId"<>NEW."loanId" OR payment."reversed" OR payment."allocationStatus" NOT IN ('ALLOCATED','UNAPPLIED') OR receipt_total<>NEW."saleProceedsCents" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Sale proceeds must be the exact live receipt credited to this loan';
    END IF;
    IF num_nulls(NEW."shortfallCents",NEW."refundCents")>0 OR (NEW."shortfallCents">0 AND NEW."refundCents">0) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Proceeds record one non-negative shortfall and refund result';
    END IF;
  END IF;
  IF NEW."status" = 'FINAL_NOTICE_ISSUED' AND NEW."finalNoticePath" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The final s127 notice bytes and digest are required';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "SurrenderRequest_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SurrenderRequest" FOR EACH ROW EXECUTE FUNCTION "guardSurrenderRequest"();
