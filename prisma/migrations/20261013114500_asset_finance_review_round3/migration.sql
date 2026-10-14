-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review, round 3: planned start window, booking
-- by the planned start, deal terms and decision record frozen from approval,
-- terminal deals frozen, released assets, identifier character policy, asset
-- release vs open loans)
-- ---------------------------------------------------------------------------

-- The planned start date fixed at document preparation
-- (lib/asset-finance/signing-prepare.ts plannedStartProblem) is no earlier
-- than the SAST date of the write and no more than 90 days after it, whenever
-- it is set or changed. A backdated start would book a loan that accrued
-- interest before anyone signed. Booking refuses once the booking day has
-- passed the start (lib/asset-finance/booking.ts start_passed): such a deal is
-- cancelled and done again.
CREATE OR REPLACE FUNCTION public."guardAssetDealPlannedStart"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF NEW."plannedStartDate" IS NULL
    OR (TG_OP = 'UPDATE' AND NEW."plannedStartDate" IS NOT DISTINCT FROM OLD."plannedStartDate") THEN
    RETURN NEW;
  END IF;
  IF NEW."plannedStartDate" < today OR NEW."plannedStartDate" > today + 90 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A deal''s planned start date must be from today (%s) to 90 days ahead (%s)', today, today + 90);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_planned_start_window" BEFORE INSERT OR UPDATE OF "plannedStartDate" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealPlannedStart"();

-- A deal is BOOKED no later than its planned start date (SAST date of the
-- write), as lib/asset-finance/booking.ts refuses start_passed: the loan
-- starts on that date, so booking after it would start a loan before it was
-- paid out. Such a deal is cancelled and done again with a new start date.
CREATE OR REPLACE FUNCTION public."guardAssetDealBookingStart"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF NEW."status" = 'BOOKED' AND OLD."status" IS DISTINCT FROM 'BOOKED' AND NEW."plannedStartDate" < today THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A deal is booked no later than its planned start date (%s; today is %s): cancel it and do it again with a new start date',
        NEW."plannedStartDate", today);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_booked_by_planned_start" BEFORE UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealBookingStart"();

-- What was approved is what is signed and booked: once a deal is APPROVED or
-- CONTRACTED its parties, application, asset, supplier, contract type, money,
-- structure and rate never change, nor does the record of the decision (the
-- decision, its reasons, who decided and when, who created the deal) or the
-- base instalment. The one base-instalment move is booking's
-- (lib/asset-finance/booking.ts): CONTRACTED → BOOKED sets it to the signed
-- instalment (signedBaseInstalmentCents). A BOOKED deal is frozen whole by
-- freezeBookedAssetDeal; the signed snapshot columns by
-- guardAssetDealSignedTerms.
CREATE OR REPLACE FUNCTION public."freezeApprovedAssetDealTerms"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" IN ('APPROVED', 'CONTRACTED') AND (
    NEW."decision" IS DISTINCT FROM OLD."decision"
    OR NEW."decisionReasons" IS DISTINCT FROM OLD."decisionReasons"
    OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById"
    OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR (NEW."baseInstalmentCents" IS DISTINCT FROM OLD."baseInstalmentCents"
      AND NOT (OLD."status" = 'CONTRACTED' AND NEW."status" = 'BOOKED'
        AND NEW."baseInstalmentCents" IS NOT DISTINCT FROM OLD."signedBaseInstalmentCents"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An approved deal''s decision record and base instalment are fixed (booking sets the base instalment to the signed one)';
  END IF;
  IF OLD."status" IN ('APPROVED', 'CONTRACTED') AND (
    NEW."entityId" IS DISTINCT FROM OLD."entityId"
    OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
    OR NEW."assetId" IS DISTINCT FROM OLD."assetId"
    OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."contractType" IS DISTINCT FROM OLD."contractType"
    OR NEW."depositCents" IS DISTINCT FROM OLD."depositCents"
    OR NEW."tradeInCents" IS DISTINCT FROM OLD."tradeInCents"
    OR NEW."financedFeesCents" IS DISTINCT FROM OLD."financedFeesCents"
    OR NEW."balloonCents" IS DISTINCT FROM OLD."balloonCents"
    OR NEW."weights" IS DISTINCT FROM OLD."weights"
    OR NEW."structurePreset" IS DISTINCT FROM OLD."structurePreset"
    OR NEW."firstDueDate" IS DISTINCT FROM OLD."firstDueDate"
    OR NEW."vatDeferralPeriodIndex" IS DISTINCT FROM OLD."vatDeferralPeriodIndex"
    OR NEW."rateBasis" IS DISTINCT FROM OLD."rateBasis"
    OR NEW."rateMargin" IS DISTINCT FROM OLD."rateMargin"
    OR NEW."fixedRate" IS DISTINCT FROM OLD."fixedRate"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An approved deal''s parties, asset, supplier, money, structure and rate are what was approved: they are fixed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_approved_terms_frozen" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."freezeApprovedAssetDealTerms"();

-- A CANCELLED, DECLINED or REFUSED_NCA deal is terminal: no column changes any
-- more (updatedAt aside). The move to CANCELLED is the cancel path's
-- (lib/asset-finance/deal-cancel.ts): it sets the status and who cancelled,
-- when and why, and nothing else. Named to fire after
-- AssetFinanceDeal_status_transitions, whose message covers a status change.
CREATE OR REPLACE FUNCTION public."freezeTerminalAssetDeal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" IN ('CANCELLED', 'DECLINED', 'REFUSED_NCA')
    AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A cancelled, declined or NCA-refused deal is terminal: it never changes';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED'
    AND (to_jsonb(NEW) - ARRAY['updatedAt', 'status', 'cancelledAt', 'cancelledById', 'cancelReason'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updatedAt', 'status', 'cancelledAt', 'cancelledById', 'cancelReason']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Cancelling a deal records who cancelled it, when and why, and changes nothing else';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_terminal_frozen" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."freezeTerminalAssetDeal"();

-- A deal never names a released asset (created on one, or moved onto one).
-- The asset row is locked FOR SHARE whatever its state, so this and a
-- concurrent release (guardFinancedAssetRelease) serialise: either the
-- release waits and then sees this deal, or this waits and sees releasedAt.
CREATE OR REPLACE FUNCTION public."guardAssetDealUnreleasedAsset"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  released TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."assetId" IS NOT DISTINCT FROM OLD."assetId" AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId" THEN
    RETURN NEW;
  END IF;
  SELECT a."releasedAt" INTO released FROM "FinancedAsset" a
  WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId"
  FOR SHARE;
  IF released IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset has been released and cannot be financed again';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_asset_unreleased" BEFORE INSERT OR UPDATE OF "tenantId", "assetId" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealUnreleasedAsset"();

-- Serial numbers and VINs: one character policy, mirrored by
-- lib/asset-finance/asset-identifier.ts. After NFKC normalisation (which
-- folds fullwidth letters, NBSP and the other Unicode spaces to ASCII) an
-- identifier holds only ASCII letters and digits and the separators
-- space - / . _ (CHECK FinancedAsset_identifiers_valid). Dashes other than
-- the hyphen-minus, punctuation, non-Latin letters and control, format or
-- zero-width characters are refused, never silently dropped. The duplicate
-- key is the NFKC form with the separators removed, ASCII upper case.
CREATE OR REPLACE FUNCTION public."assetIdentifierKey"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT upper(regexp_replace(normalize(value, NFKC), '[ ./_-]', '', 'g') COLLATE "C")
$function$;

ALTER TABLE "FinancedAsset" DROP CONSTRAINT "FinancedAsset_identifiers_printable";
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_identifiers_valid" CHECK (
  (normalize("serialNumber", NFKC) COLLATE "C") ~ '^[A-Za-z0-9 ./_-]+$'
  AND ("vin" IS NULL OR (normalize("vin", NFKC) COLLATE "C") ~ '^[A-Za-z0-9 ./_-]+$')
  AND length("assetIdentifierKey"("serialNumber")) > 0
  AND ("vin" IS NULL OR length("assetIdentifierKey"("vin")) > 0)
);

-- The expression indexes hold keys computed by the old function body:
-- rebuilt on the new one. guardAssetIdentifierAcrossColumns calls
-- assetIdentifierKey and needs no change.
DROP INDEX "FinancedAsset_serial_unreleased_key";
DROP INDEX "FinancedAsset_vin_unreleased_key";
CREATE UNIQUE INDEX "FinancedAsset_serial_unreleased_key" ON "FinancedAsset" ("tenantId", "assetIdentifierKey"("serialNumber")) WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "FinancedAsset_vin_unreleased_key" ON "FinancedAsset" ("tenantId", "assetIdentifierKey"("vin")) WHERE "releasedAt" IS NULL AND "vin" IS NOT NULL;

-- releasedAt is set once and only when nothing still finances the asset: no
-- open deal (any status but CANCELLED, DECLINED and REFUSED_NCA; a BOOKED
-- deal whose loan is COMPLETED, WRITTEN_OFF or CANCELLED is closed) and no
-- loan on it that is not COMPLETED, WRITTEN_OFF or CANCELLED (a DEFAULTED,
-- PENDING_WRITE_OFF or RESTRUCTURED loan still finances it).
CREATE OR REPLACE FUNCTION public."guardFinancedAssetRelease"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."releasedAt" IS NOT DISTINCT FROM OLD."releasedAt" THEN
    RETURN NEW;
  END IF;
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A released asset stays released';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d
    LEFT JOIN "Loan" l ON l."id" = d."loanId" AND l."tenantId" = d."tenantId"
    WHERE d."assetId" = OLD."id" AND d."tenantId" = OLD."tenantId"
      AND d."status" NOT IN ('CANCELLED', 'DECLINED', 'REFUSED_NCA')
      AND NOT (d."status" = 'BOOKED' AND l."status" IN ('COMPLETED', 'WRITTEN_OFF', 'CANCELLED'))
  ) OR EXISTS (
    SELECT 1 FROM "Loan" l
    WHERE l."assetId" = OLD."id" AND l."tenantId" = OLD."tenantId"
      AND l."status" NOT IN ('COMPLETED', 'WRITTEN_OFF', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset is released only when no open deal or active loan finances it';
  END IF;
  RETURN NEW;
END;
$function$;
