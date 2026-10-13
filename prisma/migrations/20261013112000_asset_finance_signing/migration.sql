-- AlterTable
ALTER TABLE "DealSigner" ADD COLUMN     "documentStoragePath" TEXT,
ADD COLUMN     "scanUploadedAt" TIMESTAMP(3),
ADD COLUMN     "scanUploadedById" TEXT;

-- AddForeignKey
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_tenantId_scanDocumentId_fkey" FOREIGN KEY ("tenantId", "scanDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Hand-written (deal documents and signing, goal §4.9, decision 2a.5)
-- ---------------------------------------------------------------------------

-- A suretyship is signed by a surety; the agreement and the resolution by
-- someone signing with authority for the entity.
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_role_document" CHECK (("role" = 'SURETY') = ("document" = 'SURETYSHIP'));

-- Every signer row points at the stored bytes of the document it is for and
-- binds them by sha256.
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_document_bound" CHECK (
  "documentSha256" IS NOT NULL AND "documentSha256" ~ '^[0-9a-f]{64}$'
  AND "documentStoragePath" IS NOT NULL AND length(btrim("documentStoragePath")) > 0
);

-- The evidence matches the method, all or nothing:
--   no method: nothing recorded yet;
--   E_SIGN: the signature artefact, its sha256 (computed here, so the digest
--     always describes the stored artefact), the instant and the IP, no scan;
--   WET_INK: the scan, who uploaded it and when; confirmation is both
--     columns or neither; no e-signature columns.
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_method_evidence" CHECK (
  ("method" IS NULL
    AND "signedAt" IS NULL AND "signatureData" IS NULL AND "signatureSha256" IS NULL AND "signedByIp" IS NULL
    AND "scanDocumentId" IS NULL AND "scanUploadedById" IS NULL AND "scanUploadedAt" IS NULL
    AND "confirmedById" IS NULL AND "confirmedAt" IS NULL)
  OR ("method" = 'E_SIGN'
    AND "signedAt" IS NOT NULL AND "signatureData" IS NOT NULL AND length(btrim("signatureData")) > 0
    AND "signatureSha256" IS NOT NULL
    AND "signatureSha256" = encode(sha256(convert_to("signatureData", 'UTF8')), 'hex')
    AND "scanDocumentId" IS NULL AND "scanUploadedById" IS NULL AND "scanUploadedAt" IS NULL
    AND "confirmedById" IS NULL AND "confirmedAt" IS NULL)
  OR ("method" = 'WET_INK'
    AND "scanDocumentId" IS NOT NULL AND "scanUploadedById" IS NOT NULL AND length(btrim("scanUploadedById")) > 0
    AND "scanUploadedAt" IS NOT NULL
    AND "signedAt" IS NULL AND "signatureData" IS NULL AND "signatureSha256" IS NULL AND "signedByIp" IS NULL
    AND ("confirmedById" IS NULL) = ("confirmedAt" IS NULL))
);

-- Four eyes on wet ink: the user who confirms a scan is not the user who
-- uploaded it.
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_wet_ink_four_eyes" CHECK ("confirmedById" IS NULL OR lower(btrim("confirmedById")) <> lower(btrim("scanUploadedById")));

-- Who must sign the agreement and the resolution for an entity: its active
-- AUTHORISED_SIGNATORY people; with none, every active DIRECTOR of a company
-- or TRUSTEE of a trust. A CC or partnership with no authorised signatory has
-- nobody (record its signatories first). Mirrors requiredAuthorityClientIds in
-- lib/asset-finance/signing.ts.
CREATE OR REPLACE FUNCTION public."dealRequiredSignatories"(tenant_id TEXT, entity_id TEXT)
RETURNS TABLE (signatory_id TEXT)
LANGUAGE sql
STABLE
AS $function$
  WITH signatories AS (
    SELECT r."clientId" AS id FROM "EntityRelationship" r
    WHERE r."tenantId" = tenant_id AND r."entityId" = entity_id AND r."active" AND r."role" = 'AUTHORISED_SIGNATORY'
  ), fallback AS (
    SELECT r."clientId" AS id FROM "EntityRelationship" r
    JOIN "BusinessEntity" e ON e."id" = r."entityId" AND e."tenantId" = r."tenantId"
    WHERE r."tenantId" = tenant_id AND r."entityId" = entity_id AND r."active"
      AND ((e."type" = 'COMPANY' AND r."role" = 'DIRECTOR') OR (e."type" = 'TRUST' AND r."role" = 'TRUSTEE'))
  )
  SELECT id FROM signatories
  UNION
  SELECT id FROM fallback WHERE NOT EXISTS (SELECT 1 FROM signatories)
$function$;

-- DealSigner rows are created, re-bound and removed only while their deal is
-- APPROVED, and only before anything is recorded on them. Who, which deal and
-- which document never change. A wet-ink scan is this deal's SIGNED_* document
-- of the matching kind, uploaded by the recorded staff user and not deleted.
-- Once e-signed or confirmed the row is frozen and never deleted.
CREATE OR REPLACE FUNCTION public."guardDealSigner"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_status "AssetDealStatus";
  row_deal TEXT;
  row_tenant TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_deal := OLD."dealId";
    row_tenant := OLD."tenantId";
  ELSE
    row_deal := NEW."dealId";
    row_tenant := NEW."tenantId";
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND (OLD."signedAt" IS NOT NULL OR OLD."confirmedAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A signed or confirmed deal signer is immutable';
  END IF;

  SELECT d."status" INTO deal_status FROM "AssetFinanceDeal" d WHERE d."id" = row_deal AND d."tenantId" = row_tenant;
  IF deal_status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Deal signers change only while the deal is APPROVED';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."method" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A deal signer with a signature or scan on record is never deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."method" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A deal signer is created unsigned';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."role" IS DISTINCT FROM OLD."role"
    OR NEW."document" IS DISTINCT FROM OLD."document"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A deal signer''s deal, person and document are fixed';
  END IF;

  IF OLD."method" IS NOT NULL AND (
    NEW."documentSha256" IS DISTINCT FROM OLD."documentSha256"
    OR NEW."documentStoragePath" IS DISTINCT FROM OLD."documentStoragePath"
    OR NEW."method" IS DISTINCT FROM OLD."method"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A deal signer with a scan on record keeps its document and method';
  END IF;

  IF NEW."method" = 'WET_INK' AND NOT EXISTS (
    SELECT 1 FROM "EntityDocument" d
    WHERE d."id" = NEW."scanDocumentId"
      AND d."tenantId" = NEW."tenantId"
      AND d."dealId" = NEW."dealId"
      AND d."deletedAt" IS NULL
      AND d."uploadedByType" = 'staff'
      AND d."uploadedById" = NEW."scanUploadedById"
      AND d."docType"::text = CASE NEW."document"
        WHEN 'AGREEMENT' THEN 'SIGNED_AGREEMENT'
        WHEN 'SURETYSHIP' THEN 'SIGNED_SURETYSHIP'
        WHEN 'RESOLUTION' THEN 'SIGNED_RESOLUTION'
      END
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A wet-ink scan is this deal''s signed document of the same kind, uploaded by the recorded user';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealSigner_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealSigner"
  FOR EACH ROW EXECUTE FUNCTION "guardDealSigner"();

-- A deal becomes CONTRACTED only from APPROVED, and only when the required
-- signatures are complete: the entity has someone with authority to sign;
-- there is an AGREEMENT signer; each required signatory has an AGREEMENT and
-- a RESOLUTION row; each active SURETY has a SURETYSHIP row; and every signer
-- row is satisfied — e-signed, or a confirmed wet-ink scan that is not deleted.
CREATE OR REPLACE FUNCTION public."guardAssetDealContract"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" <> 'CONTRACTED' OR (TG_OP = 'UPDATE' AND OLD."status" = 'CONTRACTED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD."status" <> 'APPROVED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An asset deal is contracted only from APPROVED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "dealRequiredSignatories"(NEW."tenantId", NEW."entityId")) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The entity has nobody with authority to sign; the deal cannot be contracted';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."document" = 'AGREEMENT') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A deal is contracted only with an AGREEMENT signer';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "dealRequiredSignatories"(NEW."tenantId", NEW."entityId") a
    WHERE NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = a.signatory_id AND s."document" = 'AGREEMENT')
       OR NOT EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = a.signatory_id AND s."document" = 'RESOLUTION')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Every authorised signatory signs the agreement and the resolution';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "EntityRelationship" r
    WHERE r."tenantId" = NEW."tenantId" AND r."entityId" = NEW."entityId" AND r."active" AND r."role" = 'SURETY'
      AND NOT EXISTS (
        SELECT 1 FROM "DealSigner" s WHERE s."dealId" = NEW."id" AND s."clientId" = r."clientId" AND s."document" = 'SURETYSHIP'
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Every active surety signs a suretyship';
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Every deal signer must have e-signed or have a confirmed wet-ink scan';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_contract_gate" BEFORE INSERT OR UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION "guardAssetDealContract"();

-- Signing evidence is kept: a scan a deal signer points at cannot be
-- soft-deleted.
CREATE OR REPLACE FUNCTION public."guardSigningEvidenceDocument"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL
    AND EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."scanDocumentId" = OLD."id" AND s."tenantId" = OLD."tenantId")
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A signed scan on record for a deal signer cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "EntityDocument_signing_evidence" BEFORE UPDATE OF "deletedAt" ON "EntityDocument"
  FOR EACH ROW EXECUTE FUNCTION "guardSigningEvidenceDocument"();
