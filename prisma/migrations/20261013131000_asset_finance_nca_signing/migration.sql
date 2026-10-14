-- A natural-person NCA asset deal signs its prescribed asset agreement through
-- the same DealSigner evidence table. Entity authority, resolution and surety
-- checks remain byte-for-byte the slice-1 rules for entity borrowers.
CREATE OR REPLACE FUNCTION public."guardAssetDealContract"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" <> 'CONTRACTED' OR (TG_OP = 'UPDATE' AND OLD."status" = 'CONTRACTED') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is contracted only from APPROVED';
  END IF;

  IF NEW."clientId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "DealSigner" s
      WHERE s."dealId" = NEW."id" AND s."clientId" = NEW."clientId" AND s."document" = 'AGREEMENT'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A natural-person asset deal is contracted only with that client as AGREEMENT signer';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "dealRequiredSignatories"(NEW."tenantId", NEW."entityId")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The entity has nobody with authority to sign; the deal cannot be contracted';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."document" = 'AGREEMENT') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is contracted only with an AGREEMENT signer';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "dealRequiredSignatories"(NEW."tenantId", NEW."entityId") a
      WHERE NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = a.signatory_id AND s."document" = 'AGREEMENT')
         OR NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = a.signatory_id AND s."document" = 'RESOLUTION')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every authorised signatory signs the agreement and the resolution';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "EntityRelationship" r
      WHERE r."tenantId" = NEW."tenantId" AND r."entityId" = NEW."entityId" AND r."active" AND r."role" = 'SURETY'
        AND NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = r."clientId" AND s."document" = 'SURETYSHIP')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every active surety signs a suretyship';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DealSigner" s
    LEFT JOIN "EntityDocument" d ON d."id" = s."scanDocumentId" AND d."tenantId" = s."tenantId"
    WHERE s."dealId" = NEW."id" AND NOT COALESCE(
      (s."method" = 'E_SIGN' AND s."signedAt" IS NOT NULL AND s."signatureSha256" IS NOT NULL)
      OR (s."method" = 'WET_INK' AND d."id" IS NOT NULL AND d."deletedAt" IS NULL AND s."confirmedById" IS NOT NULL AND s."confirmedAt" IS NOT NULL), false
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every deal signer must have e-signed or have a confirmed wet-ink scan';
  END IF;
  RETURN NEW;
END;
$function$;
