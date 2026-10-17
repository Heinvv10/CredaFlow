-- MPA s15(2)(h) requires consent for becoming surety. Section 15(4)'s
-- ratification route excludes (h). Recording earlier consent later is valid.
ALTER TABLE "SuretyConsent" ADD COLUMN "consentSignedOn" date, ADD COLUMN "suretySignedOn" date,
 ADD COLUMN "consentBeforeSurety" boolean NOT NULL DEFAULT false;

CREATE FUNCTION "guardSuretyConsentTiming"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "DealSigner";
BEGIN
 SELECT * INTO s FROM "DealSigner" WHERE "id" = NEW."signerId";
 PERFORM 1 FROM "AssetFinanceDeal" WHERE "id" = s."dealId" FOR UPDATE;
 IF NEW."maritalRegime" = 'IN_COMMUNITY' AND NEW."evidenceDocumentId" IS NOT NULL AND (
  NEW."consentSignedOn" IS NULL OR NEW."suretySignedOn" IS NULL OR NOT NEW."consentBeforeSurety"
  OR NEW."consentSignedOn" > NEW."suretySignedOn"
  OR NEW."suretySignedOn" > (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Johannesburg')::date
  OR (s."scanUploadedAt" IS NOT NULL AND NEW."suretySignedOn" > (s."scanUploadedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)
  OR NEW."consentSignedOn" > (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Johannesburg')::date
  OR (s."signedAt" IS NOT NULL AND NEW."consentSignedOn" > (s."signedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Witnessed spouse consent must be obtained before the surety signs; later consent cannot ratify a suretyship'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "SuretyConsent_timing" BEFORE INSERT OR UPDATE ON "SuretyConsent"
 FOR EACH ROW EXECUTE FUNCTION "guardSuretyConsentTiming"();

-- Confirmed DealSigner scans are already immutable (DealSigner_guard). The
-- payout guard also checks chronology against the retained scan upload date.
CREATE FUNCTION "guardPayoutConsentTiming"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status" = 'CANCELLED' THEN RETURN NEW; END IF;
 PERFORM 1 FROM "AssetFinanceDeal" WHERE "id" = NEW."dealId" FOR UPDATE;
 IF EXISTS (SELECT 1 FROM "DealSigner" s JOIN "SuretyConsent" c ON c."signerId" = s."id" AND c."tenantId" = s."tenantId"
  WHERE s."dealId" = NEW."dealId" AND s."document" = 'SURETYSHIP' AND c."maritalRegime" = 'IN_COMMUNITY' AND c."evidenceDocumentId" IS NOT NULL
   AND (c."consentSignedOn" IS NULL OR c."suretySignedOn" IS NULL OR NOT c."consentBeforeSurety"
    OR c."consentSignedOn" > c."suretySignedOn"
    OR c."suretySignedOn" > (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Johannesburg')::date
    OR (s."scanUploadedAt" IS NOT NULL AND c."suretySignedOn" > (s."scanUploadedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)
    OR c."consentSignedOn" > (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Johannesburg')::date
    OR (s."signedAt" IS NOT NULL AND c."consentSignedOn" > (s."signedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date))) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Payout requires evidence spouse consent preceded surety signing';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Payout_consent_timing" BEFORE INSERT OR UPDATE ON "Payout"
 FOR EACH ROW EXECUTE FUNCTION "guardPayoutConsentTiming"();
