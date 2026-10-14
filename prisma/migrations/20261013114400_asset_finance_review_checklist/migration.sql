-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review fixes: the serial/VIN attestation)
-- ---------------------------------------------------------------------------

-- guardPayoutChecklistItem (20261013113000) plus the attestation: confirming
-- SUPPLIER_INVOICE_MATCHES_ASSET records the serial or VIN typed off the
-- invoice (attestedIdentifier), and it must be the asset's serial or VIN as
-- assetIdentifierKey compares them. guardAssetDealBooking checks it again at
-- booking.
CREATE OR REPLACE FUNCTION public."guardPayoutChecklistItem"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_status TEXT;
  evidence_types TEXT[];
  asset_row RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A payout checklist item is never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."confirmedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A confirmed payout checklist item is immutable';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
      OR NEW."item" IS DISTINCT FROM OLD."item"
      OR NEW."required" IS DISTINCT FROM OLD."required"
      OR NEW."confirmedAt" IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A payout checklist item changes only by being confirmed';
    END IF;
  END IF;

  SELECT d."status"::TEXT INTO deal_status
  FROM "AssetFinanceDeal" d WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";
  IF deal_status IS DISTINCT FROM 'CONTRACTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Payout checklist items are created and confirmed only while the deal is CONTRACTED';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."confirmedAt" IS NOT NULL OR NEW."confirmedById" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A payout checklist item is created unconfirmed';
    END IF;
    IF NEW."required" IS DISTINCT FROM (NEW."item" IN (SELECT * FROM "payoutChecklistRequiredKinds"(NEW."tenantId", NEW."dealId"))) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('Payout checklist item %s: required must be what the requirement table says', NEW."item");
    END IF;
    RETURN NEW;
  END IF;

  evidence_types := CASE NEW."item"::TEXT
    WHEN 'SUPPLIER_INVOICE_MATCHES_ASSET' THEN ARRAY['SUPPLIER_INVOICE']
    WHEN 'SUPPLIER_BANK_VERIFIED' THEN ARRAY['BANK_STATEMENT', 'OTHER']
    WHEN 'INSURANCE_NOTES_LENDER' THEN ARRAY['INSURANCE_NOTING']
    WHEN 'TRACKER_CONFIRMED' THEN ARRAY['TRACKER_CERTIFICATE']
    WHEN 'DELIVERY_AND_ACCEPTANCE' THEN ARRAY['DELIVERY_ACCEPTANCE']
    WHEN 'NATIS_TITLEHOLDER' THEN ARRAY['NATIS_DOCUMENT']
    ELSE ARRAY[]::TEXT[]
  END;
  IF NEW."evidenceDocumentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EntityDocument" doc
    WHERE doc."id" = NEW."evidenceDocumentId" AND doc."tenantId" = NEW."tenantId"
      AND doc."dealId" = NEW."dealId" AND doc."deletedAt" IS NULL
      AND doc."uploadedByType" = 'staff'
      AND doc."docType"::TEXT = ANY (evidence_types)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Payout checklist item %s: the evidence must be a live staff upload on this deal of type %s',
        NEW."item", array_to_string(evidence_types, ' or '));
  END IF;

  SELECT a."registrationNumber", a."natisTitleholder", a."trackerId", a."lenderNotedConfirmed", d."supplierId",
         a."serialNumber", a."vin"
  INTO asset_row
  FROM "AssetFinanceDeal" d
  JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"
  WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";

  IF NEW."item" = 'SUPPLIER_INVOICE_MATCHES_ASSET' AND (
    NEW."attestedIdentifier" IS NULL
    OR "assetIdentifierKey"(NEW."attestedIdentifier") IS DISTINCT FROM "assetIdentifierKey"(asset_row."serialNumber")
      AND "assetIdentifierKey"(NEW."attestedIdentifier") IS DISTINCT FROM "assetIdentifierKey"(asset_row."vin")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The serial or VIN attested from the supplier invoice must be the asset''s';
  END IF;
  IF NEW."item" = 'INSURANCE_NOTES_LENDER' AND asset_row."lenderNotedConfirmed" IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s insurance does not record the lender''s interest as noted';
  END IF;
  IF NEW."item" = 'TRACKER_CONFIRMED' AND NULLIF(btrim(asset_row."trackerId"), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset has no tracker id';
  END IF;
  IF NEW."item" = 'SUPPLIER_BANK_VERIFIED' AND NOT EXISTS (
    SELECT 1 FROM "SupplierBankAccount" acc
    WHERE acc."tenantId" = NEW."tenantId" AND acc."supplierId" = asset_row."supplierId" AND acc."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The supplier has no APPROVED bank account';
  END IF;
  IF NEW."item" = 'NATIS_TITLEHOLDER' AND (
    NULLIF(btrim(asset_row."registrationNumber"), '') IS NULL
    OR "payoutNormalisedName"(asset_row."natisTitleholder") IS DISTINCT FROM (
      SELECT "payoutNormalisedName"(c."legalName") FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"
    )
    OR asset_row."natisTitleholder" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The eNaTIS titleholder must be the lender''s legal name';
  END IF;
  RETURN NEW;
END;
$function$;
