-- An instruction does not prove bank execution. Retain evidence before closing surplus liability.
ALTER TABLE "NcaSurplusRemittance" ADD COLUMN "executedOn" DATE, ADD COLUMN "bankExecutionReference" TEXT,
 ADD COLUMN "executionEvidenceDocumentId" TEXT, ADD COLUMN "executedById" TEXT, ADD COLUMN "executionRecordedAt" TIMESTAMP(3);
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_execution_all_or_none" CHECK (
 ("executedOn" IS NULL AND "bankExecutionReference" IS NULL AND "executionEvidenceDocumentId" IS NULL AND "executedById" IS NULL AND "executionRecordedAt" IS NULL)
 OR ("status"='INSTRUCTED' AND "executedOn" IS NOT NULL AND "bankExecutionReference" IS NOT NULL AND "executionEvidenceDocumentId" IS NOT NULL AND "executedById" IS NOT NULL AND "executionRecordedAt" IS NOT NULL));
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_execution_document_fkey" FOREIGN KEY ("tenantId","executionEvidenceDocumentId") REFERENCES "EntityDocument"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "NcaSurplusRemittance" ADD CONSTRAINT "NcaSurplusRemittance_executed_by_fkey" FOREIGN KEY ("tenantId","executedById") REFERENCES "User"("tenantId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION public."guardNcaSurplusRemittance"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE parent RECORD; account RECORD;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus payment instructions are immutable'; END IF;
  IF OLD."status"='INSTRUCTED' AND NEW."status"='INSTRUCTED' THEN
   IF OLD."executedOn" IS NOT NULL OR NEW."executedOn" IS NULL OR NEW."executedById" IS NULL OR NEW."executionEvidenceDocumentId" IS NULL
     OR NEW."executionRecordedAt" IS NULL OR length(btrim(COALESCE(NEW."bankExecutionReference",''))) NOT BETWEEN 6 AND 200
     OR (to_jsonb(NEW)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution evidence is recorded once without changing its instruction';
   END IF;
   NEW."executionRecordedAt":=now();
  ELSIF OLD."status"<>'HELD_NO_VERIFIED_ACCOUNT'  OR NEW."status"<>'INSTRUCTED'
    OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."releasedById" IS NULL
    OR (to_jsonb(NEW)-ARRAY['status','accountId','releasedAt','releasedById']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','accountId','releasedAt','releasedById'])
    OR NOT EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderId" AND s."tenantId"=NEW."tenantId" AND s."status"='FINAL_NOTICE_ISSUED' AND s."finalNoticePath" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "Recovery" r WHERE r."surrenderRequestId"=s."id")) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only a held standalone surplus may issue once after bank authorisation';
  END IF;
  IF OLD."status"='HELD_NO_VERIFIED_ACCOUNT' THEN NEW."releasedAt" := now(); END IF;
 ELSIF NEW."executedOn" IS NOT NULL OR NEW."bankExecutionReference" IS NOT NULL OR NEW."executionEvidenceDocumentId" IS NOT NULL OR NEW."executedById" IS NOT NULL OR NEW."executionRecordedAt" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution follows an existing instruction and final notice';
 ELSIF NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surplus release follows its recorded exception';
 END IF;
 IF NEW."surrenderId" IS NOT NULL THEN
  SELECT "loanId", "status"::TEXT AS status,"refundCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "SurrenderRequest" WHERE "id"=NEW."surrenderId" AND "tenantId"=NEW."tenantId" FOR SHARE;
 ELSE
  SELECT "loanId", "status"::TEXT AS status,"surplusCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "Recovery" WHERE "id"=NEW."recoveryId" AND "tenantId"=NEW."tenantId" AND "route"='NCA_S131_ATTACHMENT' FOR SHARE;
 END IF;
 IF NOT FOUND OR parent.status NOT IN ('PROCEEDS_CREDITED','PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED') OR NEW."amountCents" IS DISTINCT FROM parent.surplus THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction equals the notice surplus';
 END IF;
 SELECT * INTO account FROM "NcaSurplusAccount" WHERE "tenantId"=NEW."tenantId" AND "loanId"=parent."loanId" FOR SHARE;
 IF NEW."status"='INSTRUCTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId" AND l."status"='COMPLETED') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus is remitted only after the loan is settled';
  END IF;
  IF account."id" IS DISTINCT FROM NEW."accountId" OR account."approvedById" IS NULL OR account."releaseAuthorisedById" IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction requires verified bank and prior release authority';
  END IF;
 ELSIF account."approvedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A verified bank account cannot be reported unavailable';
 END IF;
 IF NEW."executedOn" IS NOT NULL THEN
  IF parent.status<>'FINAL_NOTICE_ISSUED' OR parent.notice_path IS NULL OR NEW."executedOn" < (COALESCE(OLD."releasedAt",OLD."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date OR NEW."executedOn">(now() AT TIME ZONE 'Africa/Johannesburg')::date
    OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d JOIN "Loan" l ON l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId"
      WHERE d."id"=NEW."executionEvidenceDocumentId" AND d."tenantId"=NEW."tenantId" AND d."deletedAt" IS NULL
        AND d."clientId" IS NOT DISTINCT FROM l."clientId" AND d."entityId" IS NOT DISTINCT FROM l."entityId"
        AND d."docType" IN ('BANK_STATEMENT','OTHER') AND d."uploadedByType"='staff' AND d."uploadedById"=NEW."executedById"
        AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."fileSize">0) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Execution needs final notice, valid bank date and retained borrower-owned staff bank evidence';
  END IF;
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
    allowed := ARRAY['location', 'condition', 'meterReadingId', 'valuationNoticeIssuedOn', 'valuationNoticeReceivedOn', 'valuationReceiptReference'];
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
  IF NEW."valuationNoticeIssuedOn" IS DISTINCT FROM OLD."valuationNoticeIssuedOn"
      AND NOT (OLD."status"='VALUED' AND NEW."status"='VALUATION_NOTICE_ISSUED')
      AND NOT (OLD."status"=NEW."status" AND OLD."status"::text IN ('VALUATION_NOTICE_ISSUED','PROCEEDS_CREDITED','LISTED','SOLD','PROCEEDS_APPLIED') AND OLD."valuationNoticePath" IS NOT NULL
        AND OLD."valuationNoticeIssuedOn" IS NULL AND OLD."valuationNoticeReceivedOn" IS NULL
        AND NEW."valuationNoticeIssuedOn" IS NOT NULL AND NEW."valuationNoticeReceivedOn" IS NOT NULL
        AND length(btrim(COALESCE(NEW."valuationReceiptReference",'')))>=10) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Notice issue date is immutable except once with historical issue and receipt evidence';
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
      IF NOT (NEW."shortfallCents" - NEW."unrecoverableCostsCents" = 0 AND EXISTS (
        SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED' AND r."executedOn" IS NOT NULL
        AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A recovery closes straight from its proceeds only with no shortfall and no surplus';
      END IF;
    END IF;
  ELSIF step = 'SHORTFALL_OPEN>CLOSED' THEN
    IF loan_row.status NOT IN ('COMPLETED', 'WRITTEN_OFF') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A shortfall closes when the loan is settled or written off';
    END IF;
  ELSIF step = 'SURPLUS_HELD>CLOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM "RecoveryRefund" r WHERE r."recoveryId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'RELEASED') AND NOT EXISTS (
      SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND r."status"='INSTRUCTED' AND r."executedOn" IS NOT NULL
      AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents") THEN
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

CREATE OR REPLACE FUNCTION public."guardNcaSurplusBankEvidence"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
 IF (EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."evidenceDocumentId"=OLD."id") OR EXISTS (SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."executionEvidenceDocumentId"=OLD."id"))
   AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt')) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus bank evidence is retained unchanged';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$function$;
