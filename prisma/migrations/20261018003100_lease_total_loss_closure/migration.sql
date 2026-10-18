CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  returns_on DATE;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF NEW."outcome" = 'TOTAL_LOSS' AND (NEW."origin" <> 'EARLY_TERMINATION' OR NOT EXISTS (
    SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."tenantId" = NEW."tenantId" AND q."loanId" = NEW."loanId"
      AND q."totalLoss" AND q."status" = 'ACCEPTED' AND NULLIF(btrim(q."lossEvidence"), '') IS NOT NULL
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss end needs the accepted evidenced loss of this lease';
  END IF;
  IF NEW."outcome" = 'TOTAL_LOSS' AND (NEW."inspectedOn" IS NOT NULL OR NEW."finalReadingId" IS NOT NULL
    OR NEW."inspectionCondition" IS NOT NULL OR NEW."inspectedById" IS NOT NULL OR NEW."excessUsageCents" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total loss is not a physical return or fabricated inspection';
  END IF;
  IF NEW."outcome" = 'TOTAL_LOSS' AND NEW."status" IN ('INVOICED', 'COMPLETED') AND (
    NOT EXISTS (SELECT 1 FROM "FinancedAsset" a WHERE a."id" = loan_row."assetId" AND a."tenantId" = NEW."tenantId" AND a."lessorStatus" = 'TOTAL_LOSS')
    OR EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."loanId" = NEW."loanId" AND f."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A billed total loss retains the lost asset state and settles its maintenance fund';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL
       OR NEW."inspectedOn" IS NOT NULL OR NEW."extensionNoticeOn" IS NOT NULL OR NEW."extensionEndsOn" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
    -- The elector changes only with a re-based purchase (the re-baser elects); purchase terms only while ELECTED.
    OR ((NEW."electedById" IS DISTINCT FROM OLD."electedById" OR NEW."electedByClientId" IS DISTINCT FROM OLD."electedByClientId")
      AND NOT (OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' AND NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."status" <> 'ELECTED' AND (NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents"
      OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
    OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
    OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
      OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition" OR NEW."inspectedById" IS DISTINCT FROM OLD."inspectedById"))
    OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn")
    OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn"
      AND NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND q."status" = 'ACCEPTED' AND q."lessorCancellation" AND q."terminationDate" = NEW."extensionEndsOn"))
    OR (OLD."natisTransferConfirmedAt" IS NOT NULL AND NEW."natisTransferConfirmedAt" IS DISTINCT FROM OLD."natisTransferConfirmedAt")
    OR (OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents" IS DISTINCT FROM OLD."excessUsageCents"
      OR NEW."fundSettlementCents" IS DISTINCT FROM OLD."fundSettlementCents")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
  END IF;
  -- An elected purchase is re-based only when its valuation has aged out: by staff (who become the
  -- elector), onto another valuation, at that valuation's amount, under the same rule as the election.
  IF NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId" THEN
    IF NEW."purchaseValuationId" IS NOT DISTINCT FROM OLD."purchaseValuationId" OR NEW."electedById" IS NULL OR NEW."electedByClientId" IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM "AssetValuation" o JOIN "AssetValuation" n ON n."id" = NEW."purchaseValuationId" AND n."tenantId" = o."tenantId"
         WHERE o."id" = OLD."purchaseValuationId" AND o."tenantId" = NEW."tenantId" AND o."valuedOn" < today - max_age
           AND NEW."purchasePriceExclVatCents" = n."amountCents"
           -- the house rule's valuation: no current market valuation of the asset is higher
           AND NOT EXISTS (SELECT 1 FROM "AssetValuation" b WHERE b."tenantId" = n."tenantId" AND b."assetId" = n."assetId"
             AND b."source" IN ('ASSESSOR', 'DEALER') AND b."valuedOn" >= today - max_age AND b."amountCents" > n."amountCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is re-based by staff only once its valuation has aged out, on the highest current valuation, at its amount';
    END IF;
    IF NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
  END IF;
  -- Notice ends an extension a month on (or at its last appended rental), given between the election and today.
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NOT (NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")) AND (
      NEW."outcome" <> 'EXTEND' OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
      OR NEW."extensionNoticeOn" > today OR NEW."extensionEndsOn" IS NULL
      -- On the first rental date (stepping a month at a time from the last rental, as the daily run appends
      -- them) at least a month after the notice and not before the billed period ends.
      OR (NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM (
        WITH RECURSIVE step(d, i) AS (
          SELECT MAX(r."dueDate"), 0 FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."cancelledAt" IS NULL
          UNION ALL SELECT (step.d + INTERVAL '1 month')::date, step.i + 1 FROM step WHERE step.i < 120)
        SELECT MIN(step.d) FROM step
        WHERE step.d >= GREATEST((NEW."extensionNoticeOn" + INTERVAL '1 month')::date, public."leaseTermEnd"(NEW."loanId", NEW."tenantId"))))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Notice is given between the election and today, and ends the extension on the first rental date a month after it and after the billed period';
  END IF;
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")
    AND (NEW."extensionNoticeOn" > today OR (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date > NEW."extensionNoticeOn"
      OR NEW."extensionEndsOn" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."extensionNoticeOn", 20)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A CPA lessee ends continuation on 20 business days notice';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'ELECTED' AND NEW."status" = 'INSPECTED' AND NEW."outcome" = 'RETURN')
    OR (OLD."status" = 'EXTENDING' AND NEW."status" = 'INSPECTED' AND NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" <= today)
    OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'INVOICED')
    OR (OLD."status" = 'ELECTED' AND NEW."status" = 'INVOICED' AND NEW."outcome" IN ('PURCHASE', 'TOTAL_LOSS'))
    OR (OLD."status" = 'INVOICED' AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s end of term cannot move from %s to %s', NEW."outcome", OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'INSPECTED' AND OLD."status" <> 'INSPECTED' THEN
    -- The asset is inspected once it comes back: when the term (or the extension) ends, or on the accepted termination's date.
    returns_on := CASE
      WHEN NEW."origin" = 'EARLY_TERMINATION' THEN (SELECT q."terminationDate" FROM "LeaseTerminationQuote" q
        WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss"))
      WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"
      ELSE public."leaseTermEnd"(NEW."loanId", NEW."tenantId") END;
    IF returns_on IS NULL OR NEW."inspectedOn" < returns_on OR NEW."inspectedOn" > today
       OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A return is inspected from the day the asset comes back, after the election, never in the future';
    END IF;
    -- The final reading is this lease's asset's, taken at the inspection, and the latest.
    IF NEW."finalReadingId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."finalReadingId" AND m."tenantId" = NEW."tenantId"
          AND m."assetId" = loan_row."assetId" AND m."readingDate" = NEW."inspectedOn"
          AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" x WHERE x."tenantId" = m."tenantId" AND x."assetId" = m."assetId"
            AND x."unit" = m."unit" AND x."readingDate" > m."readingDate")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final reading is the lease''s asset''s latest, taken at the inspection';
    END IF;
  END IF;
  IF NEW."status" = 'INVOICED' AND OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' THEN
    -- A purchase is sold when the term ends, on a valuation still current.
    SELECT v."valuedOn" INTO valuation FROM "AssetValuation" v WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    IF today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR valuation."valuedOn" < today - max_age THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is invoiced when the term ends, on a current valuation';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."totalPaid" < r."totalDue") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term completes once everything owed on the lease is paid';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- Additional asset protections: a loss cannot become stock, a sale or a new financed asset.
CREATE FUNCTION public."guardTotalLossAsset"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."lessorStatus" = 'TOTAL_LOSS' AND NEW."lessorStatus" IS DISTINCT FROM OLD."lessorStatus" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset cannot be returned to stock or sold';
  END IF;
  IF NEW."lessorStatus" = 'TOTAL_LOSS' AND NOT EXISTS (
    SELECT 1 FROM "Loan" l JOIN "LeaseTerminationQuote" q ON q."tenantId" = l."tenantId" AND q."loanId" = l."id"
      JOIN "LeaseEndOfTerm" e ON e."tenantId" = l."tenantId" AND e."loanId" = l."id"
    WHERE l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."id" AND q."totalLoss" AND q."status" = 'ACCEPTED'
      AND NULLIF(btrim(q."lossEvidence"), '') IS NOT NULL AND e."outcome" = 'TOTAL_LOSS'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset needs its accepted evidenced lease loss';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "FinancedAsset_total_loss_guard" BEFORE INSERT OR UPDATE ON "FinancedAsset"
FOR EACH ROW EXECUTE FUNCTION public."guardTotalLossAsset"();

CREATE FUNCTION public."guardNoTotalLossAssetFinancing"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" AND a."lessorStatus" = 'TOTAL_LOSS' FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss asset cannot be financed again';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetFinanceDeal_total_loss_guard" BEFORE INSERT OR UPDATE OF "assetId", "tenantId" ON "AssetFinanceDeal"
FOR EACH ROW EXECUTE FUNCTION public."guardNoTotalLossAssetFinancing"();
CREATE TRIGGER "Loan_total_loss_guard" BEFORE INSERT OR UPDATE OF "assetId", "tenantId" ON "Loan"
FOR EACH ROW EXECUTE FUNCTION public."guardNoTotalLossAssetFinancing"();

-- Actual external fund refunds after total loss: existing cash movements need evidence.
ALTER TABLE "MaintenanceFundMovement" ADD COLUMN "refundDocumentId" TEXT, ADD COLUMN "refundReference" TEXT;
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_refundDocumentId_fkey"
FOREIGN KEY ("tenantId", "refundDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_refundDocumentId_key" ON "MaintenanceFundMovement"("tenantId", "refundDocumentId");
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_refundReference_key" ON "MaintenanceFundMovement"("tenantId", "refundReference");
CREATE FUNCTION public."guardTotalLossFundRefund"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE loss_on DATE; lease_id TEXT; balance_cents BIGINT;
BEGIN
  SELECT f."loanId", q."terminationDate" INTO lease_id, loss_on FROM "MaintenanceFund" f
    JOIN "LeaseTerminationQuote" q ON q."tenantId" = f."tenantId" AND q."loanId" = f."loanId" AND q."totalLoss" AND q."status" = 'ACCEPTED'
    WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId";
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL THEN
    PERFORM 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId" FOR UPDATE;
    SELECT COALESCE(SUM(CASE WHEN m."kind" IN ('CONTRIBUTION', 'SETTLEMENT_BILLED') THEN m."amountCents" ELSE -m."amountCents" END), 0)
      INTO balance_cents FROM "MaintenanceFundMovement" m WHERE m."fundId" = NEW."fundId" AND m."tenantId" = NEW."tenantId";
    IF NEW."amountCents" <> balance_cents OR balance_cents <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss refund is the exact positive maintenance-fund surplus';
    END IF;
  END IF;
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL THEN
    PERFORM 1 FROM "EntityDocument" d WHERE d."id" = NEW."refundDocumentId" AND d."tenantId" = NEW."tenantId" FOR UPDATE;
    -- A separate live predicate below observes a delete that won the row lock.
  END IF;
  IF NEW."kind" = 'SETTLEMENT_REFUND' AND loss_on IS NOT NULL AND (
    NEW."refundReference" IS NULL OR NEW."refundReference" <> upper(btrim(NEW."refundReference")) OR length(NEW."refundReference") NOT BETWEEN 1 AND 120
    OR NEW."occurredOn" < loss_on OR NEW."occurredOn" > (now() AT TIME ZONE 'Africa/Johannesburg')::date
    OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d JOIN "AssetFinanceDeal" a ON a."id" = d."dealId" AND a."tenantId" = d."tenantId"
      WHERE d."id" = NEW."refundDocumentId" AND d."tenantId" = NEW."tenantId" AND d."deletedAt" IS NULL AND d."uploadedByType" = 'staff'
        AND d."fileSize" > 0 AND a."loanId" = lease_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A total-loss maintenance refund requires actual date, unique bank reference and retained proof for this lease';
  END IF;
  IF (NEW."refundDocumentId" IS NOT NULL OR NEW."refundReference" IS NOT NULL) AND (NEW."kind" <> 'SETTLEMENT_REFUND' OR loss_on IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loss-refund evidence belongs only to this total-loss fund refund';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "MaintenanceFundMovement_total_loss_refund_guard" BEFORE INSERT ON "MaintenanceFundMovement"
FOR EACH ROW EXECUTE FUNCTION public."guardTotalLossFundRefund"();

CREATE FUNCTION public."guardRetainedLossRefundProof"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "MaintenanceFundMovement" m WHERE m."tenantId" = OLD."tenantId" AND m."refundDocumentId" = OLD."id")
    AND (to_jsonb(NEW) - ARRAY['verifiedAt', 'verifiedById']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['verifiedAt', 'verifiedById']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An actual maintenance refund proof is retained';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "EntityDocument_loss_refund_retained_guard" BEFORE UPDATE ON "EntityDocument"
FOR EACH ROW EXECUTE FUNCTION public."guardRetainedLossRefundProof"();
