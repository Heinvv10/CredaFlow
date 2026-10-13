-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review fixes: the asset register)
-- ---------------------------------------------------------------------------

-- A serial number or VIN as the duplicate checks compare it: upper case, with
-- every whitespace character (NBSP and the other Unicode spaces included),
-- every zero-width character and the separators - / . _ removed, so
-- "TEST F8", "TEST-F8" and "test.f8" are one machine. Mirrors
-- assetIdentifierKey in lib/asset-finance/asset-identifier.ts.
CREATE OR REPLACE FUNCTION public."assetIdentifierKey"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $function$
  SELECT upper(regexp_replace(value, '[\s\u0085  ᠎ -‍    ⁠　﻿/._-]', '', 'g'))
$function$;

-- No control or zero-width character is stored in an identifier (the app
-- strips the zero-width ones and refuses the rest).
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_identifiers_printable" CHECK (
  "serialNumber" !~ '[\u0001-\u001F\u007F-\u009F᠎​-‏ -‮⁠-⁤﻿]'
  AND ("vin" IS NULL OR "vin" !~ '[\u0001-\u001F\u007F-\u009F᠎​-‏ -‮⁠-⁤﻿]')
  AND length("assetIdentifierKey"("serialNumber")) > 0
  AND ("vin" IS NULL OR length("assetIdentifierKey"("vin")) > 0)
);

-- The book-wide duplicate checks compare the normalised identifiers.
DROP INDEX "FinancedAsset_serial_unreleased_key";
DROP INDEX "FinancedAsset_vin_unreleased_key";
CREATE UNIQUE INDEX "FinancedAsset_serial_unreleased_key" ON "FinancedAsset" ("tenantId", "assetIdentifierKey"("serialNumber")) WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "FinancedAsset_vin_unreleased_key" ON "FinancedAsset" ("tenantId", "assetIdentifierKey"("vin")) WHERE "releasedAt" IS NULL AND "vin" IS NOT NULL;

-- Across the two columns too: one unreleased asset's serial is not another
-- unreleased asset's VIN. (An asset whose serial is its own VIN is one
-- machine.) Writers of the same identifier queue on an advisory lock per
-- (tenant, identifier), taken in a fixed order, so two concurrent inserts
-- cannot both miss each other.
CREATE OR REPLACE FUNCTION public."guardAssetIdentifierAcrossColumns"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  serial_key TEXT := "assetIdentifierKey"(NEW."serialNumber");
  vin_key TEXT := "assetIdentifierKey"(NEW."vin");
  lock_key TEXT;
BEGIN
  IF NEW."releasedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  FOR lock_key IN SELECT k FROM unnest(ARRAY[serial_key, vin_key]) AS k WHERE k IS NOT NULL ORDER BY k LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('asset-identifier:' || NEW."tenantId" || ':' || lock_key, 0));
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM "FinancedAsset" a
    WHERE a."tenantId" = NEW."tenantId" AND a."id" <> NEW."id" AND a."releasedAt" IS NULL
      AND (("assetIdentifierKey"(a."vin") = serial_key)
        OR (vin_key IS NOT NULL AND "assetIdentifierKey"(a."serialNumber") = vin_key))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'FinancedAsset_identifier_cross_key',
      MESSAGE = 'An unreleased asset already carries this identifier as its serial number or VIN';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "FinancedAsset_identifier_cross_check" BEFORE INSERT OR UPDATE OF "tenantId", "serialNumber", "vin", "releasedAt" ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetIdentifierAcrossColumns"();

-- The VAT on an asset is the VAT on its exclusive cash price at the rate in
-- force today (SAST), half-up: vatHalfUpCents, the same arithmetic as
-- lib/vat/amounts.ts vatOnExclusive. Checked whenever the price or the VAT is
-- written, so the booking invoice's split of the inclusive price agrees with
-- the stored figures to the cent.
CREATE OR REPLACE FUNCTION public."guardFinancedAssetVat"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rate NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."cashPriceExclVatCents" IS NOT DISTINCT FROM OLD."cashPriceExclVatCents"
    AND NEW."vatCents" IS NOT DISTINCT FROM OLD."vatCents" THEN
    RETURN NEW;
  END IF;
  SELECT v."rate" INTO rate FROM "VatRate" v
  WHERE v."effectiveDate" <= (now() AT TIME ZONE 'Africa/Johannesburg')::date
  ORDER BY v."effectiveDate" DESC LIMIT 1;
  IF rate IS NULL OR NEW."vatCents"::BIGINT <> "vatHalfUpCents"(NEW."cashPriceExclVatCents", rate) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('An asset''s VAT must be the VAT on its exclusive cash price at the rate in force today (%s cents)',
        "vatHalfUpCents"(NEW."cashPriceExclVatCents", rate));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "FinancedAsset_vat_matches_rate" BEFORE INSERT OR UPDATE OF "cashPriceExclVatCents", "vatCents" ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardFinancedAssetVat"();

-- What the agreement describes is frozen from the credit approval: once a
-- deal on the asset is APPROVED, CONTRACTED or BOOKED, its class, make,
-- model, year, identifiers, registration and price never change. Insurance,
-- tracker and eNaTIS facts are frozen once the checklist item that attests
-- them is confirmed on any deal of the asset.
CREATE OR REPLACE FUNCTION public."guardFinancedAssetIdentity"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."assetClass" IS DISTINCT FROM OLD."assetClass"
      OR NEW."make" IS DISTINCT FROM OLD."make"
      OR NEW."model" IS DISTINCT FROM OLD."model"
      OR NEW."year" IS DISTINCT FROM OLD."year"
      OR NEW."serialNumber" IS DISTINCT FROM OLD."serialNumber"
      OR NEW."vin" IS DISTINCT FROM OLD."vin"
      OR NEW."engineNumber" IS DISTINCT FROM OLD."engineNumber"
      OR NEW."registrationNumber" IS DISTINCT FROM OLD."registrationNumber"
      OR NEW."cashPriceExclVatCents" IS DISTINCT FROM OLD."cashPriceExclVatCents"
      OR NEW."vatCents" IS DISTINCT FROM OLD."vatCents"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")
    AND EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" d
      WHERE d."assetId" = OLD."id" AND d."tenantId" = OLD."tenantId" AND d."status" IN ('APPROVED', 'CONTRACTED', 'BOOKED')
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The asset is on an approved deal: its identity and price are fixed';
  END IF;
  IF (NEW."lenderNotedConfirmed" IS DISTINCT FROM OLD."lenderNotedConfirmed"
      OR NEW."insurer" IS DISTINCT FROM OLD."insurer"
      OR NEW."policyNumber" IS DISTINCT FROM OLD."policyNumber")
    AND "assetChecklistConfirmed"(OLD."tenantId", OLD."id", 'INSURANCE_NOTES_LENDER')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s insurance is attested on a payout checklist; it is fixed';
  END IF;
  IF NEW."trackerId" IS DISTINCT FROM OLD."trackerId" AND "assetChecklistConfirmed"(OLD."tenantId", OLD."id", 'TRACKER_CONFIRMED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s tracker is attested on a payout checklist; it is fixed';
  END IF;
  IF NEW."natisTitleholder" IS DISTINCT FROM OLD."natisTitleholder" AND "assetChecklistConfirmed"(OLD."tenantId", OLD."id", 'NATIS_TITLEHOLDER') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s eNaTIS titleholder is attested on a payout checklist; it is fixed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assetChecklistConfirmed"(tenant_id TEXT, asset_id TEXT, kind "PayoutChecklistItemKind")
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM "PayoutChecklistItem" i
    JOIN "AssetFinanceDeal" d ON d."id" = i."dealId" AND d."tenantId" = i."tenantId"
    WHERE d."tenantId" = tenant_id AND d."assetId" = asset_id AND i."item" = kind AND i."confirmedAt" IS NOT NULL
  )
$function$;

CREATE TRIGGER "FinancedAsset_identity_frozen" BEFORE UPDATE ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardFinancedAssetIdentity"();

-- releasedAt frees an asset's identifiers for a new registration. It is set
-- once (never changed, never cleared) and only when nothing still finances
-- the asset: no open deal (open = any status but CANCELLED, DECLINED and
-- REFUSED_NCA, and a BOOKED deal whose loan is COMPLETED, WRITTEN_OFF or
-- CANCELLED is closed) and no ACTIVE loan on it. Its writers are the deal
-- cancel path (lib/asset-finance/deal-cancel.ts) and, later, settlement.
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
    SELECT 1 FROM "Loan" l WHERE l."assetId" = OLD."id" AND l."tenantId" = OLD."tenantId" AND l."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset is released only when no open deal or active loan finances it';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "FinancedAsset_release_guard" BEFORE UPDATE OF "releasedAt" ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardFinancedAssetRelease"();
