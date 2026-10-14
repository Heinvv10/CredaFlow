-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review fixes: payout, booking, contract rate)
-- ---------------------------------------------------------------------------

-- guardPayout (20261013113000) plus cancellation: PENDING_APPROVAL or
-- APPROVED → CANCELLED while the deal is CONTRACTED, approval fields kept,
-- cancelled by and at recorded (CHECK Payout_status_shape). A CANCELLED
-- payout, like a RELEASED one, never changes.
CREATE OR REPLACE FUNCTION public."guardPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_row RECORD;
  threshold INTEGER;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is never deleted';
  END IF;

  SELECT d."status"::TEXT AS status, d."supplierId", d."depositCents", d."tradeInCents",
         a."cashPriceExclVatCents", a."vatCents"
  INTO deal_row
  FROM "AssetFinanceDeal" d
  JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"
  WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId"
  FOR SHARE OF d, a;

  IF TG_OP = 'INSERT' THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is created only for a CONTRACTED deal';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "payoutChecklistRequiredKinds"(NEW."tenantId", NEW."dealId") AS kind
      WHERE NOT EXISTS (
        SELECT 1 FROM "PayoutChecklistItem" i
        WHERE i."dealId" = NEW."dealId" AND i."tenantId" = NEW."tenantId" AND i."item" = kind AND i."confirmedAt" IS NOT NULL
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout needs every required checklist item confirmed';
    END IF;
    PERFORM 1 FROM "SupplierBankAccount" acc
    WHERE acc."id" = NEW."supplierBankAccountId" AND acc."tenantId" = NEW."tenantId"
      AND acc."supplierId" = deal_row."supplierId" AND acc."status" = 'APPROVED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout goes only to the deal supplier''s APPROVED bank account';
    END IF;
    IF NEW."amountCents"::BIGINT <> deal_row."cashPriceExclVatCents"::BIGINT + deal_row."vatCents" - deal_row."depositCents" - deal_row."tradeInCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is the cash price incl. VAT less the deposit and the trade-in';
    END IF;
    SELECT c."assetPayoutDualApprovalCents" INTO threshold FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
    NEW."dualApprovalRequired" := threshold IS NULL OR NEW."amountCents" >= threshold;
    IF NEW."status" NOT IN ('PENDING_APPROVAL', 'APPROVED')
      OR NEW."status" <> (CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED' END)::"PayoutStatus" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format(
        'A payout of %s cents is created %s (dual approval from %s cents)',
        NEW."amountCents", CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED by its creator' END, threshold);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RELEASED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A released payout is immutable';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancelled payout is immutable';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
    OR NEW."supplierBankAccountId" IS DISTINCT FROM OLD."supplierBankAccountId"
    OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."dualApprovalRequired" IS DISTINCT FROM OLD."dualApprovalRequired"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout''s deal, account, amount and creator are fixed';
  END IF;

  IF OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED' THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is approved only while its deal is CONTRACTED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('PENDING_APPROVAL', 'APPROVED') AND NEW."status" = 'CANCELLED'
    AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
    AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
  THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is cancelled only while its deal is CONTRACTED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'APPROVED' AND NEW."status" = 'RELEASED'
    AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
    AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
  THEN
    IF deal_row.status IS DISTINCT FROM 'BOOKED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is released only with its deal BOOKED';
    END IF;
    PERFORM 1 FROM "SupplierBankAccount" acc
    WHERE acc."id" = NEW."supplierBankAccountId" AND acc."tenantId" = NEW."tenantId" AND acc."status" = 'APPROVED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is released only to a bank account that is still APPROVED';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A payout cannot move from %s to %s', OLD."status", NEW."status");
END;
$function$;

-- guardAssetDealBooking (20261013113000) plus the signed terms: the loan
-- starts on the deal's plannedStartDate and carries the deal's signed arrears
-- terms; the deal's instalment is the signed one; the loan's contract rate on
-- the start date is the signed rate; and the serial/VIN attested from the
-- supplier invoice is still the asset's.
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
    IF NEW."loanId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal names its loan only when it is booked';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR OLD."status" <> 'CONTRACTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is booked only from CONTRACTED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Loan" l
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."applicationId" = NEW."applicationId" AND l."entityId" = NEW."entityId"
      AND l."assetId" = NEW."assetId" AND l."ncaRegime" = 'NON_NCA' AND l."contractType" = NEW."contractType"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal names a NON_NCA loan on its own application, entity and asset';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Payout" p WHERE p."dealId" = NEW."id" AND p."tenantId" = NEW."tenantId" AND p."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is booked only with its payout APPROVED';
  END IF;
  IF NEW."plannedStartDate" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "Loan" l
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date = NEW."plannedStartDate"
      AND l."nonNcaDefaultInterestMargin" IS NOT DISTINCT FROM NEW."signedArrearsMarginRate"
      AND l."nonNcaCollectionFeeCents" IS NOT DISTINCT FROM NEW."signedCollectionFeeCents"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A booked loan starts on the deal''s planned start date and carries the signed arrears terms';
  END IF;
  IF NEW."baseInstalmentCents" IS DISTINCT FROM NEW."signedBaseInstalmentCents" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal''s instalment is the signed instalment';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "ContractRate" c
    WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId"
      AND c."effectiveDate" = NEW."plannedStartDate" AND c."resultingRate" = NEW."signedResultingRate"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked loan''s contract rate on its start date is the signed rate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "PayoutChecklistItem" i
    JOIN "FinancedAsset" a ON a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId"
    WHERE i."dealId" = NEW."id" AND i."tenantId" = NEW."tenantId" AND i."item" = 'SUPPLIER_INVOICE_MATCHES_ASSET'
      AND i."confirmedAt" IS NOT NULL
      AND "assetIdentifierKey"(i."attestedIdentifier") IN ("assetIdentifierKey"(a."serialNumber"), "assetIdentifierKey"(a."vin"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A deal is booked only while the serial/VIN attested from the supplier invoice is the asset''s';
  END IF;
  RETURN NEW;
END;
$function$;

-- guardContractRate (20261013100500) plus the first row of a loan booked from
-- an asset deal: its basis and margin (or fixed rate) are the deal's, and it
-- takes effect on the loan's start date (SAST).
CREATE OR REPLACE FUNCTION public."guardContractRate"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  loan_start DATE;
  loan_application TEXT;
  latest DATE;
  previous RECORD;
  deal_terms RECORD;
  reference_rate NUMERIC;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ContractRate is insert-only: %s refused (a rate change is a new row)', TG_OP);
  END IF;
  SELECT (loan."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date, loan."applicationId"
  INTO loan_start, loan_application
  FROM "Loan" AS loan
  WHERE loan."id" = NEW."loanId" AND loan."tenantId" = NEW."tenantId"
    AND loan."ncaRegime" = 'NON_NCA' AND loan."contractType" <> 'LOAN';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate belongs to a NON_NCA asset-finance contract of the same tenant';
  END IF;
  IF NEW."effectiveDate" > (current_date + INTERVAL '1 year')::date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A contract rate may not take effect more than a year ahead';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('contract-rate:' || NEW."loanId", 0));
  SELECT c."effectiveDate", c."basis", c."margin", c."fixedRate" INTO previous
  FROM "ContractRate" AS c WHERE c."loanId" = NEW."loanId"
  ORDER BY c."effectiveDate" DESC LIMIT 1;
  latest := previous."effectiveDate";
  IF NEW."effectiveDate" < coalesce(latest, loan_start) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('A contract rate may not take effect before %s (the loan''s %s)',
        coalesce(latest, loan_start), CASE WHEN latest IS NULL THEN 'start date' ELSE 'latest contract rate' END);
  END IF;
  IF latest IS NULL THEN
    SELECT d."rateBasis", d."rateMargin", d."fixedRate" INTO deal_terms
    FROM "AssetFinanceDeal" d WHERE d."applicationId" = loan_application AND d."tenantId" = NEW."tenantId";
    IF FOUND AND (
      NEW."effectiveDate" <> loan_start
      OR NEW."basis" IS DISTINCT FROM deal_terms."rateBasis"
      OR (NEW."basis" = 'FIXED' AND NEW."fixedRate" IS DISTINCT FROM deal_terms."fixedRate")
      OR (NEW."basis" <> 'FIXED' AND NEW."margin" IS DISTINCT FROM deal_terms."rateMargin")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A loan''s first contract rate is its deal''s basis and margin (or fixed rate), effective on the loan''s start date';
    END IF;
  END IF;
  -- PARTIAL: variations need a re-signed agreement (slice 1 refuses them).
  IF latest IS NOT NULL AND (
    NEW."basis" IS DISTINCT FROM previous."basis"
    OR NEW."margin" IS DISTINCT FROM previous."margin"
    OR NEW."fixedRate" IS DISTINCT FROM previous."fixedRate"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('A contract rate keeps the loan''s basis and margin (or fixed rate) of %s: a change is a contract variation, refused',
        latest);
  END IF;
  IF NEW."basis" <> 'FIXED' THEN
    SELECT reference."rate" INTO reference_rate FROM "ReferenceRate" AS reference
    WHERE reference."tenantId" = NEW."tenantId" AND reference."basis" = NEW."basis"
      AND reference."status" = 'APPROVED' AND reference."effectiveDate" <= NEW."effectiveDate"
    ORDER BY reference."effectiveDate" DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A reference-linked contract rate needs an approved reference rate of its basis in effect on its date';
    END IF;
    -- A NULL margin is left to CHECK ContractRate_fixed_xor_margin.
    IF NEW."margin" IS NOT NULL AND NEW."resultingRate" IS DISTINCT FROM reference_rate + NEW."margin" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('A reference-linked contract rate''s resulting rate must be the approved %s rate in force on its date (%s) plus its margin',
          NEW."basis", reference_rate);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
