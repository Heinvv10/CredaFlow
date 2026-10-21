-- Valuation guides (docs/asset-finance/SLICE5.md part C, deviation 2): a
-- GUIDE valuation is a reference, never an independent valuation. A recovery
-- sale relies on, is measured against, and is self-valued by current
-- valuations that are neither INTERNAL nor GUIDE. guardRemarketingSale as
-- 20261015400000_asset_finance_recovery wrote it, the three source clauses
-- changed and nothing else. (A lease purchase already admits only ASSESSOR and
-- DEALER valuations: purchaseValuationOk is unchanged.)
-- Tests: lib/valuation-guides/not-independent.integration.test.ts.

CREATE OR REPLACE FUNCTION public."guardRemarketingSale"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  rec RECORD;
  max_age INTEGER;
  highest INTEGER;
  self_valued BOOLEAN;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A remarketing sale is never deleted: cancel it';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" <> 'PENDING_APPROVAL' THEN
      IF NOT (OLD."status" = 'COMPLETED' AND OLD."proceedsPaymentId" IS NULL AND NEW."proceedsPaymentId" IS NOT NULL
          AND (to_jsonb(NEW) - 'proceedsPaymentId') = (to_jsonb(OLD) - 'proceedsPaymentId')) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed or cancelled sale is immutable (its proceeds payment is set once)';
      END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status', 'approvedById', 'approvedAt', 'completedAt', 'taxInvoiceId'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approvedById', 'approvedAt', 'completedAt', 'taxInvoiceId']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A pending sale changes only its approval, completion and invoice';
    END IF;
    -- Approval is its own earlier step, written once; the step that completes a sale does not approve it.
    IF OLD."approvedById" IS NOT NULL AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale''s approval is written once';
    END IF;
    IF NEW."status" = 'COMPLETED' AND (NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale is approved before the step that completes it';
    END IF;
    IF NEW."status" <> 'COMPLETED' THEN
      RETURN NEW;
    END IF;
  ELSIF NEW."status" <> 'PENDING_APPROVAL' OR num_nonnulls(NEW."approvedById", NEW."approvedAt", NEW."completedAt", NEW."taxInvoiceId", NEW."proceedsPaymentId") > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale opens PENDING_APPROVAL, unapproved and uninvoiced';
  END IF;

  SELECT r."status"::TEXT AS status, r."assetId", r."loanId" INTO rec
    FROM "Recovery" r WHERE r."id" = NEW."recoveryId" AND r."tenantId" = NEW."tenantId" FOR SHARE;
  IF NOT FOUND OR rec.status <> 'LISTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale is recorded and completed on a listed recovery';
  END IF;
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF NOT EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId"
      AND v."source" NOT IN ('INTERNAL', 'GUIDE') AND v."valuedOn" >= today - max_age) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A sale relies on an independent (not internal) valuation of this asset dated within %s days', max_age);
  END IF;
  SELECT COALESCE(max(v."amountCents"), 0) INTO highest FROM "AssetValuation" v
    WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" NOT IN ('INTERNAL', 'GUIDE') AND v."valuedOn" >= today - max_age;
  IF NEW."belowValuation" IS DISTINCT FROM (NEW."priceInclVatCents" < highest) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'belowValuation is whether the price is under the highest current independent valuation';
  END IF;
  -- Nobody sells on a value they set themselves without a second approver: the valuation the sale relies on, or
  -- the highest current independent one (a tie counts if any of the tied was theirs), was recorded by the proposer.
  -- UNTESTED: the lender's valuation-independence policy.
  self_valued := EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."id" = NEW."valuationId" AND v."tenantId" = NEW."tenantId" AND v."createdById" = NEW."createdById")
    OR EXISTS (SELECT 1 FROM "AssetValuation" v WHERE v."tenantId" = NEW."tenantId" AND v."assetId" = rec."assetId" AND v."source" NOT IN ('INTERNAL', 'GUIDE')
      AND v."valuedOn" >= today - max_age AND v."amountCents" = highest AND v."createdById" = NEW."createdById");
  IF TG_OP = 'UPDATE' THEN
    IF NOT NEW."selfValued" AND self_valued THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale on a valuation its proposer recorded needs the sale re-recorded as self-valued';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId" AND i."loanId" IS NULL
        AND i."totalInclVatCents" = NEW."priceInclVatCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A sale''s tax invoice is for its price, issued to the buyer outside the loan';
    END IF;
    IF NOT NEW."relatedPartyMatch" AND public."recoveryBuyerRelated"(NEW."tenantId", rec."loanId", NEW."buyerIdentifier") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A buyer who is now a related party needs the sale re-recorded';
    END IF;
    RETURN NEW;
  END IF;

  IF self_valued THEN
    NEW."selfValued" := true;
  END IF;
  IF NEW."highestValuationCents" <> highest THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The highest valuation recorded is the highest current independent valuation';
  END IF;
  -- The database cannot see hidden relationships, but a buyer who carries the borrower's, or a
  -- related client's, ID or registration number is a related party whatever the screening says.
  IF public."recoveryBuyerRelated"(NEW."tenantId", rec."loanId", NEW."buyerIdentifier") THEN
    NEW."relatedPartyMatch" := true;
  END IF;
  RETURN NEW;
END;
$function$;
