-- New migration; index replacement approved by Hein 2026-10-17.
BEGIN;
ALTER TABLE "SurrenderRequest"
 ADD COLUMN "valuationNoticeIssuedOn" DATE,
 ADD COLUMN "valuationNoticeReceivedOn" DATE,
 ADD COLUMN "valuationReceiptReference" TEXT,
 ADD COLUMN "goodsReturnedOn" DATE,
 ADD COLUMN "goodsReturnReference" TEXT,
 ADD COLUMN "chargesFrozenFrom" DATE,
 ADD COLUMN "chargesFrozenUntil" DATE;
ALTER TABLE "Recovery"
 ADD COLUMN "valuationNoticeIssuedOn" DATE,
 ADD COLUMN "valuationNoticeReceivedOn" DATE,
 ADD COLUMN "valuationReceiptReference" TEXT;
CREATE UNIQUE INDEX "SurrenderRequest_one_live_per_loan" ON "SurrenderRequest"("loanId")
 WHERE "status" NOT IN ('FINAL_NOTICE_ISSUED', 'WITHDRAWN');
DROP INDEX "SurrenderRequest_one_open_per_loan";
ALTER INDEX "SurrenderRequest_one_live_per_loan" RENAME TO "SurrenderRequest_one_open_per_loan";
CREATE OR REPLACE FUNCTION public."guardSurrenderRequest"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE valuation RECORD; payment RECORD; loan_row RECORD; receipt_total INTEGER; today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date; changed TEXT[]; allowed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A voluntary-surrender record is never deleted'; END IF;
  SELECT l."ncaRegime", l."contractType", l."assetId", l."status", l."outstandingPrincipal", l."chargesOutstanding", l."arrearsAmount"
  INTO loan_row FROM "Loan" l WHERE l."id"=NEW."loanId" AND l."tenantId"=NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row."ncaRegime" <> 'NCA' OR loan_row."contractType" = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Voluntary surrender belongs to an NCA asset-finance loan and its financed asset';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference",NEW."goodsReturnedOn",NEW."goodsReturnReference",NEW."chargesFrozenFrom",NEW."chargesFrozenUntil")>0 OR NEW."status" <> 'REQUESTED' OR loan_row."status" NOT IN ('ACTIVE','DEFAULTED') OR NEW."valuationId" IS NOT NULL OR NEW."valuationNoticePath" IS NOT NULL OR NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surrender opens REQUESTED on an active or defaulted NCA asset loan without later evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id",NEW."tenantId",NEW."loanId",NEW."assetId",NEW."requestedByType",NEW."requestedById",NEW."requestedOn",NEW."assetCondition",NEW."valuationDueOn")
    IS DISTINCT FROM (OLD."id",OLD."tenantId",OLD."loanId",OLD."assetId",OLD."requestedByType",OLD."requestedById",OLD."requestedOn",OLD."assetCondition",OLD."valuationDueOn") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender request and statutory deadline are immutable';
  END IF;
  IF OLD."status" IN ('WITHDRAWN','FINAL_NOTICE_ISSUED') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A closed surrender is immutable';
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status','updatedAt'));
  IF NEW."status" = 'WITHDRAWN' THEN
    IF loan_row."status"='DEFAULTED' OR loan_row."arrearsAmount">0 OR EXISTS(
        SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId"=NEW."loanId" AND r."totalDue">r."totalPaid" AND (r."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date<today)
      OR OLD."status" <> 'VALUATION_NOTICE_ISSUED' OR OLD."valuationNoticeReceivedOn" IS NULL
      OR today > public."recoveryAddBusinessDays"(OLD."valuationNoticeReceivedOn",10)
      OR NEW."goodsReturnedOn" IS DISTINCT FROM today OR length(btrim(COALESCE(NEW."goodsReturnReference",''))) < 10
      OR EXISTS (SELECT 1 FROM "Recovery" r JOIN "RemarketingSale" s ON s."recoveryId"=r."id"
        WHERE r."surrenderRequestId"=NEW."id" AND s."status" <> 'CANCELLED') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal within ten business days requires return of unsold goods';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(changed) k WHERE k NOT IN ('goodsReturnedOn','goodsReturnReference')) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Withdrawal changes only the goods return evidence';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status" THEN
    IF OLD."status" <> 'VALUATION_NOTICE_ISSUED' OR OLD."valuationNoticeReceivedOn" IS NOT NULL
      OR EXISTS (SELECT 1 FROM unnest(changed) k WHERE k NOT IN ('valuationNoticeReceivedOn','valuationReceiptReference')) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only valuation receipt evidence may be recorded once without a surrender step';
    END IF;
  ELSIF (OLD."status",NEW."status") NOT IN (
    ('REQUESTED','VALUED'),('VALUED','VALUATION_NOTICE_ISSUED'),('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED'),('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED')
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The surrender follows request, valuation, valuation notice, proceeds and final notice in order'; END IF;
  IF OLD."status" <> NEW."status" THEN
    allowed := CASE NEW."status"::TEXT
      WHEN 'VALUED' THEN ARRAY['valuationId']
      WHEN 'VALUATION_NOTICE_ISSUED' THEN ARRAY['valuationNoticePath','valuationNoticeSha256']
      WHEN 'PROCEEDS_CREDITED' THEN ARRAY['saleProceedsCents','proceedsPaymentId','shortfallCents','refundCents']
      WHEN 'FINAL_NOTICE_ISSUED' THEN ARRAY['finalNoticePath','finalNoticeSha256']
      ELSE ARRAY[]::TEXT[] END;
    IF EXISTS (SELECT 1 FROM unnest(changed) k WHERE k <> ALL(allowed)) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surrender valuation, notices, proceeds and freeze are write-once';
    END IF;
  END IF;
  IF NEW."status" = 'VALUATION_NOTICE_ISSUED' AND OLD."status" = 'VALUED' THEN NEW."valuationNoticeIssuedOn" := today; END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
    OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
    OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF NEW."status" IN ('VALUED','VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN
    SELECT * INTO valuation FROM "AssetValuation" v WHERE v."id"=NEW."valuationId" AND v."tenantId"=NEW."tenantId" AND v."assetId"=NEW."assetId";
    IF NOT FOUND OR valuation."valuedOn" < NEW."requestedOn" OR valuation."valuedOn" > NEW."valuationDueOn" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The s127 valuation must be for this asset within the recorded statutory window';
    END IF;
  END IF;
  IF NEW."status" IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') AND NEW."valuationNoticePath" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The valuation notice bytes and digest are required';
  END IF;
  IF NEW."status" IN ('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN
    SELECT p."amount",p."allocationStatus",p."reversed",p."loanId",p."receivedAt" INTO payment FROM "Payment" p WHERE p."id"=NEW."proceedsPaymentId" AND p."tenantId"=NEW."tenantId";
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
  IF NEW."status" = 'PROCEEDS_CREDITED' AND OLD."status" <> NEW."status" THEN
    NEW."chargesFrozenFrom" := (payment."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date;
    NEW."chargesFrozenUntil" := NULL;
  END IF;
  IF NEW."status" = 'FINAL_NOTICE_ISSUED' THEN
    NEW."chargesFrozenUntil" := public."recoveryAddBusinessDays"(today,10);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRecovery"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  surrender RECORD;
  config RECORD;
  costs RECORD;
  nca BOOLEAN;
  step TEXT;
  allowed TEXT[];
  changed TEXT[];
  expected_receipt INTEGER;
  receipt_total INTEGER;
  sale_price INTEGER;
  sale_day DATE;
  live_status TEXT;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is never deleted';
  END IF;
  nca := NEW."route" IN ('NCA_S127_SURRENDER', 'NCA_S131_ATTACHMENT');
  SELECT l."ncaRegime"::TEXT AS regime, l."contractType"::TEXT AS contract_type, l."assetId", l."status"::TEXT AS status INTO loan_row
    FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR KEY SHARE;
  IF NOT FOUND OR loan_row.contract_type = 'LOAN' OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery belongs to an asset-finance loan and its financed asset';
  END IF;
  IF nca <> (loan_row.regime = 'NCA') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The recovery route must match the loan''s NCA regime';
  END IF;
  IF NEW."meterReadingId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."meterReadingId" IS DISTINCT FROM OLD."meterReadingId") AND NOT EXISTS (
      SELECT 1 FROM "AssetMeterReading" r WHERE r."id" = NEW."meterReadingId" AND r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s meter reading is its own asset''s';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."valuationNoticeIssuedOn",NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")>0 OR NEW."status" <> 'RECOVERED' OR num_nonnulls(NEW."valuationId", NEW."valuationNoticePath", NEW."finalNoticePath", NEW."settlementDueCents",
        NEW."proceedsPaymentId", NEW."finalNoticeIssuedOn", NEW."chargesFrozenFrom", NEW."chargesFrozenUntil", NEW."withdrawnReason", NEW."closedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery opens RECOVERED, with no valuation, notice, figures, payment, freeze or closure yet';
    END IF;
    IF NEW."recoveredOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is not dated in the future';
    END IF;
    -- Locks, in this order, on the rows the checks below read, so a concurrent booking, completion or credit cannot slip
    -- between the check and the commit (READ COMMITTED): the loan (FOR SHARE: its status cannot change under us), the
    -- asset (FOR UPDATE: it conflicts with the key-share lock a Loan insert takes through its foreign key, and with the
    -- Loan guard's share lock) and the surrender (FOR UPDATE: a credit of it waits, then sees this recovery).
    SELECT l."status"::TEXT INTO live_status FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" FOR SHARE;
    IF live_status NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened on an active, defaulted or pending write-off loan';
    END IF;
    -- the asset's lessor status before the recovery: none, or the stock a lease returned (a re-leased asset is recovered too)
    SELECT a."lessorStatus" INTO NEW."previousLessorStatus" FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
    -- the loan that holds the asset now: an asset a lease returned and a new lease took is the new lease's
    IF EXISTS (SELECT 1 FROM "Loan" o WHERE o."tenantId" = NEW."tenantId" AND o."assetId" = NEW."assetId" AND o."id" <> NEW."loanId"
        AND o."status" NOT IN ('COMPLETED', 'CANCELLED', 'WRITTEN_OFF')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is opened by the loan that holds the asset now';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NEW."surrenderRequestId" IS NOT NULL THEN
      PERFORM 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" IN ('REQUESTED', 'VALUED', 'VALUATION_NOTICE_ISSUED') FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows a surrender that has not yet been credited or finally noticed';
      END IF;
    END IF;
    IF NEW."surrenderRequestId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."loanId" = NEW."loanId" AND s."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery names the surrender of its own loan and asset';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."loanId" = NEW."loanId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery''s legal matter is its own loan''s';
    END IF;
    IF NEW."legalMatterId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LegalMatter" m
        WHERE m."id" = NEW."legalMatterId" AND m."tenantId" = NEW."tenantId" AND m."status" <> 'OPEN') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery stands on an open legal matter';
    END IF;
    IF NEW."route" = 'NCA_S131_ATTACHMENT' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'ATTACHMENT_ORDER', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 recovery needs the legal matter''s attachment order';
    END IF;
    IF NEW."route" = 'NON_NCA_COURT_ORDER' AND NOT public."legalMatterHasStep"(NEW."tenantId", NEW."legalMatterId", 'JUDGMENT', NEW."recoveredOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA court-order recovery needs the legal matter''s judgment';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CLOSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed or withdrawn recovery is final';
  END IF;
  -- The columns this step may write. Everything else is fixed: the loan, asset, route, surrender,
  -- legal matter, date and creator from the start, and the valuation, notices, figures, payment and
  -- freeze dates once written, because each is written by exactly one step.
  step := OLD."status"::TEXT || '>' || NEW."status"::TEXT;
  IF OLD."status" = NEW."status" THEN
    allowed := ARRAY['location', 'condition', 'meterReadingId', 'valuationNoticeReceivedOn', 'valuationReceiptReference'];
    -- once the proceeds are applied, the costs the ledger could not carry are recorded: NULL to a value, in this status only
    IF OLD."status" = 'PROCEEDS_APPLIED' AND OLD."unrecoverableCostsCents" IS NULL THEN
      allowed := allowed || ARRAY['unrecoverableCostsCents'];
    END IF;
  ELSIF step = 'RECOVERED>VALUED' THEN
    allowed := ARRAY['valuationId'];
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    allowed := ARRAY['valuationNoticePath', 'valuationNoticeSha256', 'valuationNoticeIssuedOn'];
  ELSIF step IN ('VALUATION_NOTICE_ISSUED>LISTED', 'VALUED>LISTED', 'LISTED>SOLD', 'FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    allowed := ARRAY[]::TEXT[];
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    allowed := ARRAY['settlementDueCents', 'grossProceedsCents', 'deductedCostsCents', 'chargedCostsCents', 'netProceedsCents', 'shortfallCents', 'surplusCents', 'proceedsPaymentId', 'chargesFrozenFrom', 'chargesFrozenUntil', 'unrecoverableCostsCents'];
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    allowed := ARRAY['finalNoticeIssuedOn', 'finalNoticePath', 'finalNoticeSha256', 'chargesFrozenUntil'];
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED', 'SHORTFALL_OPEN>CLOSED', 'SURPLUS_HELD>CLOSED') THEN
    allowed := ARRAY['closedAt'];
  ELSIF step IN ('RECOVERED>WITHDRAWN', 'VALUED>WITHDRAWN', 'VALUATION_NOTICE_ISSUED>WITHDRAWN', 'LISTED>WITHDRAWN') THEN
    allowed := ARRAY['withdrawnReason', 'closedAt'];
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A recovery cannot go from %s to %s', OLD."status", NEW."status");
  END IF;
  changed := ARRAY(SELECT n.key FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('status', 'updatedAt'));
  IF EXISTS (SELECT 1 FROM unnest(changed) AS k WHERE k <> ALL (allowed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A recovery''s figures, payment, notices and freeze dates are write-once: %s may change only %s', step, array_to_string(allowed, ', '));
  END IF;
  IF NEW."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeIssuedOn" IS NULL
      OR NEW."valuationNoticeReceivedOn" < NEW."valuationNoticeIssuedOn" OR NEW."valuationNoticeReceivedOn" > today
      OR length(btrim(COALESCE(NEW."valuationReceiptReference",''))) < 10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt needs a date after issue and delivery evidence';
  END IF;
  IF OLD."valuationNoticeReceivedOn" IS NOT NULL AND (NEW."valuationNoticeReceivedOn",NEW."valuationReceiptReference")
    IS DISTINCT FROM (OLD."valuationNoticeReceivedOn",OLD."valuationReceiptReference") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Valuation receipt evidence is immutable';
  END IF;
  IF OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  -- The route rules of the matrix: NCA recoveries issue notices, NON_NCA ones do not.
  IF step IN ('VALUED>VALUATION_NOTICE_ISSUED', 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED') AND NOT nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an NCA recovery issues a valuation or final notice';
  END IF;
  IF step = 'VALUED>LISTED' AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery is listed only after its valuation notice';
  END IF;
  IF step IN ('PROCEEDS_APPLIED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SURPLUS_HELD', 'PROCEEDS_APPLIED>CLOSED') AND nca THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA recovery gives its final notice before the shortfall or surplus is opened';
  END IF;

  IF step = 'RECOVERED>VALUED' THEN
    IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = NEW."assetId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is valued by a valuation of its own asset';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' AND NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s
        WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."valuationId" = NEW."valuationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery reuses its surrender''s valuation';
    END IF;
  ELSIF step = 'VALUED>VALUATION_NOTICE_ISSUED' THEN
    NEW."valuationNoticeIssuedOn" := today;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId"
          AND s."status" >= 'VALUATION_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s valuation notice';
      END IF;
    ELSIF NEW."valuationNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 valuation notice is stored with its digest';
    END IF;
  ELSIF step = 'LISTED>SOLD' THEN
    IF NOT EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery is sold by a completed remarketing sale';
    END IF;
  ELSIF step = 'SOLD>PROCEEDS_APPLIED' THEN
    -- Charges freeze from the day the proceeds are applied: the caller does not choose the date.
    IF NEW."settlementDueCents" IS NULL OR NEW."chargesFrozenFrom" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied with the full figures and the date charges freeze from';
    END IF;
    SELECT s."priceInclVatCents", (s."completedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date INTO sale_price, sale_day
      FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED';
    IF NEW."settlementDueCents" IS NOT NULL AND NEW."grossProceedsCents" IS DISTINCT FROM sale_price THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The gross proceeds are the completed sale''s price';
    END IF;
    IF EXISTS (SELECT 1 FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'PENDING') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Proceeds are applied once every cost is decided';
    END IF;
    -- only approved costs are deducted or charged; a rejected one is neither
    SELECT COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'DEDUCT_FROM_PROCEEDS'), 0) AS deducted,
           COALESCE(sum(c."grossCents") FILTER (WHERE c."treatment" = 'CHARGE_TO_ACCOUNT'), 0) AS charged INTO costs
      FROM "RecoveryCost" c WHERE c."recoveryId" = NEW."id" AND c."tenantId" = NEW."tenantId" AND c."status" = 'APPROVED';
    IF NEW."deductedCostsCents" <> costs.deducted OR NEW."chargedCostsCents" <> costs.charged THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The deducted and charged costs are the recovery''s recorded costs';
    END IF;
    expected_receipt := LEAST(NEW."netProceedsCents", NEW."settlementDueCents");
    IF expected_receipt > 0 THEN
      SELECT p."amount" + COALESCE((SELECT sum(child."amount") FROM "Payment" child WHERE child."parentPaymentId" = p."id" AND NOT child."reversed"), 0) INTO receipt_total
        FROM "Payment" p WHERE p."id" = NEW."proceedsPaymentId" AND p."tenantId" = NEW."tenantId" AND p."loanId" = NEW."loanId" AND NOT p."reversed"
          -- the receipt of this recovery's proceeds (its idempotency key), received on or after the day the sale completed
          AND p."idempotencyKey" = 'asset-recovery:' || NEW."id" || ':proceeds'
          AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date >= sale_day;
      IF receipt_total IS DISTINCT FROM expected_receipt THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The proceeds receipt is the lesser of the net proceeds and the settlement, credited to this loan';
      END IF;
    ELSIF NEW."proceedsPaymentId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'No receipt is credited when the net proceeds or the settlement is nil';
    END IF;
    -- UNTESTED: the charge freeze (NCA s127(8); a NON_NCA demand period) is for the lender's legal team to sign off.
    IF nca THEN
      IF NEW."chargesFrozenUntil" IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An NCA freeze ends 10 business days after the final notice, set with it';
      END IF;
    ELSE
      SELECT c."nonNcaDemandPeriodDays" INTO config FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
      IF NEW."chargesFrozenUntil" IS DISTINCT FROM NEW."chargesFrozenFrom" + COALESCE(config."nonNcaDemandPeriodDays", 10) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A NON_NCA freeze runs the lender''s demand period from the proceeds';
      END IF;
    END IF;
  -- UNTESTED: s127(8) read as 10 SA business days after the final notice.
  ELSIF step = 'PROCEEDS_APPLIED>FINAL_NOTICE_ISSUED' THEN
    -- the notice states what is owed: not before the costs the ledger could not carry are known
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the final notice';
    END IF;
    IF NEW."finalNoticeIssuedOn" IS DISTINCT FROM today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final notice is dated from the proceeds to today';
    END IF;
    IF NEW."chargesFrozenUntil" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."finalNoticeIssuedOn", 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Charges stay frozen until 10 business days after the final notice';
    END IF;
    IF NEW."route" = 'NCA_S127_SURRENDER' THEN
      IF NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id" = NEW."surrenderRequestId" AND s."tenantId" = NEW."tenantId" AND s."status" = 'FINAL_NOTICE_ISSUED') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s127 recovery follows its surrender''s final notice';
      END IF;
    ELSIF NEW."finalNoticePath" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An s131 final notice is stored with its digest';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SHORTFALL_OPEN', 'PROCEEDS_APPLIED>SHORTFALL_OPEN') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before a shortfall is opened';
    END IF;
    -- what is still owed: the shortfall less the charged costs that could not go on the ledger
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <= 0 OR NEW."chargesFrozenUntil" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall is open for a positive shortfall with its freeze end set';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>SURPLUS_HELD', 'PROCEEDS_APPLIED>SURPLUS_HELD') THEN
    IF NEW."surplusCents" <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held for a positive surplus';
    END IF;
    -- the debtor's account is settled (the receipt paid it in full) before any surplus is held for refund
    IF loan_row.status <> 'COMPLETED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus is held only once the loan is settled';
    END IF;
  ELSIF step IN ('FINAL_NOTICE_ISSUED>CLOSED', 'PROCEEDS_APPLIED>CLOSED') THEN
    IF NEW."unrecoverableCostsCents" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The costs the loan''s ledger could not carry are recorded before the recovery closes';
    END IF;
    IF NEW."shortfallCents" - NEW."unrecoverableCostsCents" <> 0 OR NEW."surplusCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A surplus closes when its refund is released';
    END IF;
  ELSIF NEW."status" = 'WITHDRAWN' THEN
    IF length(btrim(COALESCE(NEW."withdrawnReason", ''))) < 10 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A withdrawal records its reason (at least 10 characters)';
    END IF;
    IF EXISTS (SELECT 1 FROM "RemarketingSale" s WHERE s."recoveryId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."status" = 'COMPLETED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery with a completed sale cannot be withdrawn';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardNcaSaleWindow"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE received DATE; nca BOOLEAN; today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_TABLE_NAME='SurrenderRequest' THEN
    IF NEW."status" NOT IN ('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED') THEN RETURN NEW; END IF;
    nca := true; received := NEW."valuationNoticeReceivedOn";
  ELSIF TG_TABLE_NAME='Recovery' THEN
    IF NEW."status" NOT IN ('LISTED','SOLD','PROCEEDS_APPLIED') THEN RETURN NEW; END IF;
    nca := NEW."route" IN ('NCA_S127_SURRENDER','NCA_S131_ATTACHMENT');
    received := NEW."valuationNoticeReceivedOn";
    IF NEW."surrenderRequestId" IS NOT NULL THEN
      SELECT s."valuationNoticeReceivedOn" INTO received FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderRequestId" FOR SHARE;
    END IF;
  ELSE
    IF NEW."status"='CANCELLED' THEN RETURN NEW; END IF;
    SELECT r."route" IN ('NCA_S127_SURRENDER','NCA_S131_ATTACHMENT'), COALESCE(s."valuationNoticeReceivedOn",r."valuationNoticeReceivedOn")
    INTO nca,received FROM "Recovery" r LEFT JOIN "SurrenderRequest" s ON s."id"=r."surrenderRequestId"
    WHERE r."id"=NEW."recoveryId" FOR SHARE OF r;
  END IF;
  IF nca AND (received IS NULL OR today <= public."recoveryAddBusinessDays"(received,10)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'NCA sale waits until ten business days after valuation notice receipt';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Recovery_sale_window" BEFORE INSERT OR UPDATE ON "Recovery" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
CREATE TRIGGER "SurrenderRequest_sale_window" BEFORE INSERT OR UPDATE ON "SurrenderRequest" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
CREATE TRIGGER "RemarketingSale_nca_window" BEFORE INSERT OR UPDATE ON "RemarketingSale" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSaleWindow"();
COMMIT;
-- Receipt insert is gated too: a failed proceeds transition must never leave an applied orphan receipt.
CREATE OR REPLACE FUNCTION public."guardNcaSurrenderReceiptWindow"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE receipt_date DATE; received DATE;
BEGIN
 IF NEW."idempotencyKey" LIKE 'asset-surrender:%:proceeds' THEN
  SELECT "valuationNoticeReceivedOn" INTO received FROM "SurrenderRequest"
   WHERE "id"=split_part(NEW."idempotencyKey",':',2) AND "tenantId"=NEW."tenantId" AND "loanId"=NEW."loanId" FOR SHARE;
  receipt_date := (NEW."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date;
  IF received IS NULL OR receipt_date <= public."recoveryAddBusinessDays"(received,10) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surrender proceeds receipt waits for the valuation notice window';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;
CREATE TRIGGER "Payment_surrender_window" BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurrenderReceiptWindow"();
