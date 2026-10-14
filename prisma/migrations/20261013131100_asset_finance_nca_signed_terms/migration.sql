-- Preserve the entity signing rules while allowing a natural-person NCA deal
-- to prepare exactly one AGREEMENT signer: the client borrower.
CREATE OR REPLACE FUNCTION public."guardAssetDealSignedTerms"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW."plannedStartDate", NEW."signedBaseInstalmentCents", NEW."signedResultingRate", NEW."signedTotalInterestCents",
        NEW."signedArrearsMarginRate", NEW."signedCollectionFeeCents", NEW."preparedSigners") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is created without contract terms; they are fixed when its documents are prepared';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."plannedStartDate" IS NOT DISTINCT FROM OLD."plannedStartDate"
    AND NEW."signedBaseInstalmentCents" IS NOT DISTINCT FROM OLD."signedBaseInstalmentCents"
    AND NEW."signedResultingRate" IS NOT DISTINCT FROM OLD."signedResultingRate"
    AND NEW."signedTotalInterestCents" IS NOT DISTINCT FROM OLD."signedTotalInterestCents"
    AND NEW."signedArrearsMarginRate" IS NOT DISTINCT FROM OLD."signedArrearsMarginRate"
    AND NEW."signedCollectionFeeCents" IS NOT DISTINCT FROM OLD."signedCollectionFeeCents"
    AND NEW."preparedSigners" IS NOT DISTINCT FROM OLD."preparedSigners" THEN RETURN NEW;
  END IF;
  IF OLD."status" <> 'APPROVED' OR NEW."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal''s contract terms are prepared only while it is APPROVED';
  END IF;
  IF EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."method" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Signing has started: the deal''s contract terms are fixed';
  END IF;
  IF NEW."preparedSigners" IS NOT NULL THEN
    IF NEW."clientId" IS NOT NULL THEN
      IF jsonb_typeof(NEW."preparedSigners") IS DISTINCT FROM 'array'
        OR jsonb_array_length(NEW."preparedSigners") <> 1
        OR NEW."preparedSigners"->0->>'clientId' IS DISTINCT FROM NEW."clientId"
        OR NEW."preparedSigners"->0->>'document' IS DISTINCT FROM 'AGREEMENT' THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A natural-person deal is prepared for that client''s agreement only';
      END IF;
    ELSIF NOT "dealSignerSetIsRequired"(NEW."tenantId", NEW."entityId", NEW."preparedSigners") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The prepared signer set must be the signatures the entity requires now';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardAssetDealContract"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" <> 'CONTRACTED' OR (TG_OP = 'UPDATE' AND OLD."status" = 'CONTRACTED') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is contracted only from APPROVED';
  END IF;
  IF NEW."preparedSigners" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is contracted only once its documents are prepared';
  END IF;

  IF NEW."clientId" IS NOT NULL THEN
    IF jsonb_array_length(NEW."preparedSigners") <> 1
      OR NEW."preparedSigners"->0->>'clientId' IS DISTINCT FROM NEW."clientId"
      OR NEW."preparedSigners"->0->>'document' IS DISTINCT FROM 'AGREEMENT'
      OR NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = NEW."clientId" AND s."document" = 'AGREEMENT') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A natural-person asset deal is contracted only with that client as AGREEMENT signer';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."preparedSigners") e WHERE e->>'document' = 'AGREEMENT') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The entity has nobody with authority to sign; the deal cannot be contracted';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."preparedSigners") e
      WHERE e->>'document' IN ('AGREEMENT', 'RESOLUTION')
        AND (NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = e->>'clientId' AND s."document" = 'AGREEMENT')
          OR NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = e->>'clientId' AND s."document" = 'RESOLUTION'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every authorised signatory signs the agreement and the resolution';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW."preparedSigners") e WHERE e->>'document' = 'SURETYSHIP'
        AND NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = e->>'clientId' AND s."document" = 'SURETYSHIP')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every surety prepared for the deal signs a suretyship';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM "DealSigner" s LEFT JOIN "EntityDocument" d ON d."id" = s."scanDocumentId" AND d."tenantId" = s."tenantId"
    WHERE s."dealId" = NEW."id" AND NOT COALESCE(
      (s."method" = 'E_SIGN' AND s."signedAt" IS NOT NULL AND s."signatureSha256" IS NOT NULL)
      OR (s."method" = 'WET_INK' AND d."id" IS NOT NULL AND d."deletedAt" IS NULL AND s."confirmedById" IS NOT NULL AND s."confirmedAt" IS NOT NULL), false)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every deal signer must have e-signed or have a confirmed wet-ink scan';
  END IF;
  RETURN NEW;
END;
$function$;
