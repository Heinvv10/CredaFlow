-- Serialize the first consent reference with evidence edits. Existing legal
-- validation remains unchanged and runs after this alphabetically first guard.
CREATE FUNCTION public."lockSuretyConsentEvidence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signer "DealSigner";
BEGIN
  SELECT * INTO signer FROM "DealSigner" WHERE "id" = NEW."signerId";
  PERFORM 1 FROM "AssetFinanceDeal" WHERE "id" = signer."dealId" FOR UPDATE;
  IF NEW."maritalRegime" = 'IN_COMMUNITY' AND NEW."evidenceDocumentId" IS NOT NULL THEN
    PERFORM 1 FROM "EntityDocument" WHERE "id" = NEW."evidenceDocumentId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SuretyConsent_00_evidence_lock" BEFORE INSERT OR UPDATE ON "SuretyConsent"
FOR EACH ROW EXECUTE FUNCTION public."lockSuretyConsentEvidence"();
