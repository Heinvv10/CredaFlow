-- Slice 5 part A hardening (docs/asset-finance/SLICE5.md, deviations 20-22).
-- Hand-written: no Prisma model change. Three rules on top of
-- 20261019120100_dealer_portal; each refuses with ERRCODE 23514 like the rest.

-- Provenance is written once ------------------------------------------------

-- A dealer deal may name only a borrower and asset the same dealer captured
-- (guardAssetDealDealer reads createdByDealerId). The column is set by the
-- INSERT that captures the row and never changed after, so a staff-captured
-- row cannot be re-badged as a dealer's, nor a dealer's row moved or cleared.
CREATE OR REPLACE FUNCTION "guardCreatedByDealerFixed"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = format('%s.createdByDealerId is set when the row is created and never changed', TG_TABLE_NAME);
END;
$function$;

CREATE TRIGGER "Client_created_by_dealer_fixed" BEFORE UPDATE ON "Client"
  FOR EACH ROW WHEN (NEW."createdByDealerId" IS DISTINCT FROM OLD."createdByDealerId")
  EXECUTE FUNCTION "guardCreatedByDealerFixed"();
CREATE TRIGGER "BusinessEntity_created_by_dealer_fixed" BEFORE UPDATE ON "BusinessEntity"
  FOR EACH ROW WHEN (NEW."createdByDealerId" IS DISTINCT FROM OLD."createdByDealerId")
  EXECUTE FUNCTION "guardCreatedByDealerFixed"();
CREATE TRIGGER "FinancedAsset_created_by_dealer_fixed" BEFORE UPDATE ON "FinancedAsset"
  FOR EACH ROW WHEN (NEW."createdByDealerId" IS DISTINCT FROM OLD."createdByDealerId")
  EXECUTE FUNCTION "guardCreatedByDealerFixed"();

-- A dealer deal's parties are fixed -----------------------------------------

-- guardAssetDealDealer checks provenance on INSERT only. No code path changes
-- a deal's borrower or asset (the staff flow freezes them from APPROVED), so
-- on a dealer deal they are fixed from the start rather than re-checked.
CREATE OR REPLACE FUNCTION "guardDealerDealParties"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'A dealer deal''s borrower and asset are the ones its dealer captured: they are fixed';
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_dealer_parties_fixed" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW WHEN (OLD."dealerId" IS NOT NULL AND (
    NEW."entityId" IS DISTINCT FROM OLD."entityId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."assetId" IS DISTINCT FROM OLD."assetId"))
  EXECUTE FUNCTION "guardDealerDealParties"();

-- Payable runs net a clawback against what it claws back -------------------

-- Is the line in a run that is not cancelled (pending, approved or released)?
CREATE OR REPLACE FUNCTION "dealerCommissionLineLive"(p_tenant TEXT, p_line TEXT, p_run TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM "DealerPayableRunLine" k
    WHERE k."tenantId" = p_tenant AND k."lineId" = p_line AND NOT k."voided" AND (p_run IS NULL OR k."runId" = p_run)
  );
$function$;

-- An EARNED line joins a run only after its REVERSED line (when there is one)
-- has joined the same run: a run never pays commission already clawed back.
CREATE OR REPLACE FUNCTION "guardDealerPayableRunLineNetting"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DealerCommissionLine" r
    WHERE r."tenantId" = NEW."tenantId" AND r."reversesLineId" = NEW."lineId"
      AND NOT "dealerCommissionLineLive"(NEW."tenantId", r."id", NEW."runId")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An EARNED line joins a run only after its REVERSED line is linked to the same run';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerPayableRunLine_netting" BEFORE INSERT ON "DealerPayableRunLine"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerPayableRunLineNetting"();

-- On approval (after DealerPayableRun_guard, by trigger name order):
--  1. an EARNED line in the run that was clawed back has its reversal in the
--     run (a clawback after the line was linked); a REVERSED line in the run
--     has its EARNED line in a live run (this one or an earlier one);
--  2. every line of the dealer effective by the period end is in a live run,
--     except an EARNED line whose reversal is not: the pair nets to zero and
--     waits for the run that is due to take the reversal.
-- The run row is locked by the UPDATE, and a line joins only a pending run
-- holding FOR SHARE on it (guardDealerPayableRunLine).
CREATE OR REPLACE FUNCTION "guardDealerPayableRunNetting"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "DealerPayableRunLine" k
    JOIN "DealerCommissionLine" l ON l."id" = k."lineId" AND l."tenantId" = k."tenantId"
    WHERE k."runId" = NEW."id" AND k."tenantId" = NEW."tenantId" AND NOT k."voided"
      AND (
        (l."kind" = 'EARNED' AND EXISTS (
          SELECT 1 FROM "DealerCommissionLine" r
          WHERE r."tenantId" = l."tenantId" AND r."reversesLineId" = l."id"
            AND NOT "dealerCommissionLineLive"(NEW."tenantId", r."id", NEW."id")))
        OR (l."kind" = 'REVERSED' AND NOT "dealerCommissionLineLive"(NEW."tenantId", l."reversesLineId"))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run pays an EARNED line and its reversal together';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "DealerCommissionLine" l
    WHERE l."tenantId" = NEW."tenantId" AND l."dealerId" = NEW."dealerId" AND l."effectiveOn" <= NEW."periodEnd"
      AND NOT "dealerCommissionLineLive"(NEW."tenantId", l."id")
      AND NOT (l."kind" = 'EARNED' AND EXISTS (
        SELECT 1 FROM "DealerCommissionLine" r
        WHERE r."tenantId" = l."tenantId" AND r."reversesLineId" = l."id" AND NOT "dealerCommissionLineLive"(NEW."tenantId", r."id")))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payable run is approved with every line of its dealer due by its period end';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerPayableRun_netting" BEFORE UPDATE ON "DealerPayableRun"
  FOR EACH ROW WHEN (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED')
  EXECUTE FUNCTION "guardDealerPayableRunNetting"();
