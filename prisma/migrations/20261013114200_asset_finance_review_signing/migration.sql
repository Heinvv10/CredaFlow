-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review fixes: signed terms, signer set, cancel)
-- ---------------------------------------------------------------------------

-- The signatures a deal needs, as (client, document) pairs: the agreement and
-- the resolution per required signatory (dealRequiredSignatories), a
-- suretyship per active surety. Mirrors deriveRequiredSigners in
-- lib/asset-finance/signing.ts.
CREATE OR REPLACE FUNCTION public."dealRequiredSignerSet"(tenant_id TEXT, entity_id TEXT)
RETURNS TABLE (client_id TEXT, document TEXT)
LANGUAGE sql
STABLE
AS $function$
  SELECT a.signatory_id, v.document
  FROM "dealRequiredSignatories"(tenant_id, entity_id) a
  CROSS JOIN (VALUES ('AGREEMENT'), ('RESOLUTION')) AS v(document)
  UNION
  SELECT r."clientId", 'SURETYSHIP' FROM "EntityRelationship" r
  WHERE r."tenantId" = tenant_id AND r."entityId" = entity_id AND r."active" AND r."role" = 'SURETY'
$function$;

-- A prepared signer set is a JSON array of { clientId, document } with no
-- repeats, equal as a set to what the entity requires now.
CREATE OR REPLACE FUNCTION public."dealSignerSetIsRequired"(tenant_id TEXT, entity_id TEXT, signers JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
  IF jsonb_typeof(signers) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(signers) <> (
    SELECT count(DISTINCT (e->>'clientId', e->>'document')) FROM jsonb_array_elements(signers) e
  ) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT e->>'clientId', e->>'document' FROM jsonb_array_elements(signers) e
    EXCEPT SELECT client_id, document FROM "dealRequiredSignerSet"(tenant_id, entity_id)
  ) AND NOT EXISTS (
    SELECT client_id, document FROM "dealRequiredSignerSet"(tenant_id, entity_id)
    EXCEPT SELECT e->>'clientId', e->>'document' FROM jsonb_array_elements(signers) e
  );
END;
$function$;

-- The contract terms (plannedStartDate, signed*, preparedSigners) are absent
-- on a new deal and written only by document preparation: while the deal is
-- APPROVED, before any signature or scan is on record, with the signer set
-- the entity requires at that moment. From the first signature they are
-- fixed (and a BOOKED deal is frozen whole).
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
    AND NEW."preparedSigners" IS NOT DISTINCT FROM OLD."preparedSigners"
  THEN
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'APPROVED' OR NEW."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal''s contract terms are prepared only while it is APPROVED';
  END IF;
  IF EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."tenantId" = NEW."tenantId" AND s."method" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Signing has started: the deal''s contract terms are fixed';
  END IF;
  IF NEW."preparedSigners" IS NOT NULL AND NOT "dealSignerSetIsRequired"(NEW."tenantId", NEW."entityId", NEW."preparedSigners") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The prepared signer set must be the signatures the entity requires now';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_signed_terms_guard" BEFORE INSERT OR UPDATE OF "plannedStartDate", "signedBaseInstalmentCents",
  "signedResultingRate", "signedTotalInterestCents", "signedArrearsMarginRate", "signedCollectionFeeCents", "preparedSigners"
  ON "AssetFinanceDeal" FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealSignedTerms"();

-- A deal becomes CONTRACTED only from APPROVED, once its documents are
-- prepared, against the signer set fixed at preparation (preparedSigners),
-- not the entity's people now: that set has an agreement signer; each
-- prepared signatory has an AGREEMENT and a RESOLUTION signer row; each
-- prepared surety a SURETYSHIP row; and every signer row is satisfied —
-- e-signed, or a confirmed wet-ink scan that is not deleted.
CREATE OR REPLACE FUNCTION public."guardAssetDealContract"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" <> 'CONTRACTED' OR (TG_OP = 'UPDATE' AND OLD."status" = 'CONTRACTED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is contracted only from APPROVED';
  END IF;
  IF NEW."preparedSigners" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is contracted only once its documents are prepared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."preparedSigners") e WHERE e->>'document' = 'AGREEMENT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The entity has nobody with authority to sign; the deal cannot be contracted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."document" = 'AGREEMENT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is contracted only with an AGREEMENT signer';
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
    SELECT 1 FROM jsonb_array_elements(NEW."preparedSigners") e
    WHERE e->>'document' = 'SURETYSHIP'
      AND NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = e->>'clientId' AND s."document" = 'SURETYSHIP')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every surety prepared for the deal signs a suretyship';
  END IF;
  -- COALESCE: an unsigned row's NULL method must count as unsatisfied, not unknown.
  IF EXISTS (
    SELECT 1 FROM "DealSigner" s
    LEFT JOIN "EntityDocument" d ON d."id" = s."scanDocumentId" AND d."tenantId" = s."tenantId"
    WHERE s."dealId" = NEW."id"
      AND NOT COALESCE(
        (s."method" = 'E_SIGN' AND s."signedAt" IS NOT NULL AND s."signatureSha256" IS NOT NULL)
        OR (s."method" = 'WET_INK' AND d."id" IS NOT NULL AND d."deletedAt" IS NULL
            AND s."confirmedById" IS NOT NULL AND s."confirmedAt" IS NOT NULL),
        false)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Every deal signer must have e-signed or have a confirmed wet-ink scan';
  END IF;
  RETURN NEW;
END;
$function$;

-- The people who sign or stand surety are fixed while a deal of the entity is
-- APPROVED or CONTRACTED: an active SURETY, AUTHORISED_SIGNATORY, DIRECTOR or
-- TRUSTEE relationship is not deactivated, re-roled, moved or deleted until
-- the deal is booked or cancelled.
CREATE OR REPLACE FUNCTION public."guardEntityRelationshipOnOpenDeal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD."active" AND (NOT NEW."active" OR NEW."role" IS DISTINCT FROM OLD."role"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")) THEN
    RETURN NEW;
  END IF;
  IF OLD."active" AND OLD."role" IN ('SURETY', 'AUTHORISED_SIGNATORY', 'DIRECTOR', 'TRUSTEE') AND EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d
    WHERE d."tenantId" = OLD."tenantId" AND d."entityId" = OLD."entityId" AND d."status" IN ('APPROVED', 'CONTRACTED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The entity has an approved deal: its sureties and signatories are fixed until the deal is booked or cancelled';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "EntityRelationship_fixed_on_open_deal" BEFORE UPDATE OR DELETE ON "EntityRelationship"
  FOR EACH ROW EXECUTE FUNCTION public."guardEntityRelationshipOnOpenDeal"();

-- A payout is CANCELLED only from PENDING_APPROVAL or APPROVED, while its deal
-- is still CONTRACTED (the cancel path then cancels the deal). A cancelled
-- payout says who and when, and never changes again.
ALTER TABLE "Payout" DROP CONSTRAINT "Payout_status_shape";
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_status_shape" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'RELEASED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL
    AND "cancelledById" IS NULL AND "cancelledAt" IS NULL)
  OR ("status" = 'CANCELLED' AND ("approvedById" IS NULL) = ("approvedAt" IS NULL) AND "releasedById" IS NULL AND "releasedAt" IS NULL
    AND "cancelledById" IS NOT NULL AND "cancelledAt" IS NOT NULL)
);

-- A deal is CANCELLED only with its payout, if it has one, already CANCELLED:
-- a released payout means a booked deal (never cancelled), and an approved
-- one must not outlive its deal.
CREATE OR REPLACE FUNCTION public."guardAssetDealCancel"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'CANCELLED' AND OLD."status" IS DISTINCT FROM 'CANCELLED' AND EXISTS (
    SELECT 1 FROM "Payout" p WHERE p."dealId" = NEW."id" AND p."tenantId" = NEW."tenantId" AND p."status" <> 'CANCELLED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is cancelled only once its payout is cancelled';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_cancel_gate" BEFORE UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealCancel"();
