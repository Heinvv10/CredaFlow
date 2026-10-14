-- Booking binds either borrower kind and preserves NCA vs NON_NCA. NCA arrears
-- terms come from the statutory charges engine, so NON_NCA product margins are
-- required only on NON_NCA loans.
CREATE OR REPLACE FUNCTION public."guardAssetDealBooking"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'BOOKED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."loanId" IS DISTINCT FROM OLD."loanId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal keeps its status and its loan';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" <> 'BOOKED' THEN
    IF NEW."loanId" IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal names its loan only when it is booked'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD."status" <> 'CONTRACTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is booked only from CONTRACTED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Loan" l JOIN "LoanApplication" a ON a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."applicationId" = NEW."applicationId"
      AND l."clientId" IS NOT DISTINCT FROM NEW."clientId" AND l."entityId" IS NOT DISTINCT FROM NEW."entityId"
      AND l."assetId" = NEW."assetId" AND l."ncaRegime" = a."ncaRegime" AND l."contractType" = NEW."contractType"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal names a classified loan on its own application, borrower and asset';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Payout" p WHERE p."dealId" = NEW."id" AND p."tenantId" = NEW."tenantId" AND p."status" = 'APPROVED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is booked only with its payout APPROVED';
  END IF;
  IF NEW."plannedStartDate" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date = NEW."plannedStartDate"
      AND (l."ncaRegime" = 'NCA' OR (
        l."nonNcaDefaultInterestMargin" IS NOT DISTINCT FROM NEW."signedArrearsMarginRate"
        AND l."nonNcaCollectionFeeCents" IS NOT DISTINCT FROM NEW."signedCollectionFeeCents"
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked loan starts on the deal''s planned start date and carries the signed arrears terms';
  END IF;
  IF NEW."baseInstalmentCents" IS DISTINCT FROM NEW."signedBaseInstalmentCents" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal''s instalment is the signed instalment';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ContractRate" c WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId"
      AND c."effectiveDate" = NEW."plannedStartDate" AND c."resultingRate" = NEW."signedResultingRate"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked loan''s contract rate on its start date is the signed rate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "PayoutChecklistItem" i JOIN "FinancedAsset" a ON a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId"
    WHERE i."dealId" = NEW."id" AND i."tenantId" = NEW."tenantId" AND i."item" = 'SUPPLIER_INVOICE_MATCHES_ASSET'
      AND i."confirmedAt" IS NOT NULL AND "assetIdentifierKey"(i."attestedIdentifier") IN ("assetIdentifierKey"(a."serialNumber"), "assetIdentifierKey"(a."vin"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is booked only while the serial/VIN attested from the supplier invoice is the asset''s';
  END IF;
  RETURN NEW;
END;
$function$;
