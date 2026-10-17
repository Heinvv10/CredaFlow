ALTER TABLE "AssetFinanceDeal" ADD COLUMN "isaCpaApplies" boolean, ADD COLUMN "isaCpaRule" text;
CREATE TABLE "SuretyConsent" (
 "id" text PRIMARY KEY, "tenantId" text NOT NULL REFERENCES "Tenant"("id"),
 "signerId" text NOT NULL UNIQUE REFERENCES "DealSigner"("id") ON DELETE RESTRICT,
 "maritalRegime" text NOT NULL DEFAULT 'UNKNOWN', "spouseName" text,
 "witnessOne" text, "witnessTwo" text, "evidenceDocumentId" text,
 "verifiedById" text NOT NULL REFERENCES "User"("id"),
 "verifiedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "SuretyConsent_marital_regime" CHECK ("maritalRegime" IN ('IN_COMMUNITY','OUT_OF_COMMUNITY','UNMARRIED','UNKNOWN')),
 CONSTRAINT "SuretyConsent_spouse_evidence" CHECK ("maritalRegime" <> 'IN_COMMUNITY' OR "evidenceDocumentId" IS NULL OR (
   "evidenceDocumentId" IS NOT NULL AND "spouseName" IS NOT NULL AND "witnessOne" IS NOT NULL AND "witnessTwo" IS NOT NULL AND length(trim("spouseName")) > 0
   AND length(trim("witnessOne")) > 0 AND length(trim("witnessTwo")) > 0
   AND lower(trim("witnessOne")) <> lower(trim("witnessTwo"))))
);
CREATE FUNCTION "guardCommercialSuretyConsent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "DealSigner"; d "EntityDocument";
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW."signerId" <> OLD."signerId" OR NEW."tenantId" <> OLD."tenantId") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Surety consent identity is fixed';
 END IF;
 SELECT * INTO s FROM "DealSigner" WHERE "id" = COALESCE(NEW."signerId", OLD."signerId");
 PERFORM 1 FROM "AssetFinanceDeal" WHERE "id" = s."dealId" FOR UPDATE;
 IF EXISTS (SELECT 1 FROM "Payout" WHERE "dealId" = s."dealId" AND "status" <> 'CANCELLED') THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Surety consent cannot change after payout';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF s."document" <> 'SURETYSHIP' OR s."tenantId" <> NEW."tenantId" THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Consent must belong to this lender and suretyship';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."verifiedById" AND "tenantId" = NEW."tenantId") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Surety consent needs staff verification';
 END IF;
 IF NEW."maritalRegime" = 'IN_COMMUNITY' AND NEW."evidenceDocumentId" IS NOT NULL THEN
  SELECT * INTO d FROM "EntityDocument" WHERE "id" = NEW."evidenceDocumentId";
  IF d."id" IS NULL OR d."tenantId" <> s."tenantId" OR d."dealId" IS DISTINCT FROM s."dealId"
    OR d."deletedAt" IS NOT NULL OR d."uploadedByType" <> 'staff' OR d."docType" <> 'LEGAL_DOCUMENT' THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Spouse consent needs a staff-uploaded wet-ink legal document of this deal';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "SuretyConsent_legal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "SuretyConsent"
 FOR EACH ROW EXECUTE FUNCTION "guardCommercialSuretyConsent"();

CREATE FUNCTION "guardPayoutSuretyConsent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status" = 'CANCELLED' THEN RETURN NEW; END IF;
 PERFORM 1 FROM "AssetFinanceDeal" WHERE "id" = NEW."dealId" FOR UPDATE;
 IF EXISTS (
  SELECT 1 FROM "DealSigner" s LEFT JOIN "SuretyConsent" c ON c."signerId" = s."id" AND c."tenantId" = s."tenantId"
  LEFT JOIN "EntityDocument" d ON d."id" = c."evidenceDocumentId" AND d."tenantId" = c."tenantId"
  WHERE s."dealId" = NEW."dealId" AND s."document" = 'SURETYSHIP'
   AND (c."id" IS NULL OR c."maritalRegime" = 'UNKNOWN' OR
    (c."maritalRegime" = 'IN_COMMUNITY' AND (d."id" IS NULL OR d."deletedAt" IS NOT NULL)))
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Payout requires every surety marital regime and verified spouse consent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "Payout_surety_consent" BEFORE INSERT OR UPDATE ON "Payout"
 FOR EACH ROW EXECUTE FUNCTION "guardPayoutSuretyConsent"();

CREATE FUNCTION "guardSuretyshipWetInk"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."document" = 'SURETYSHIP' AND NEW."method" = 'E_SIGN' THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Suretyships require wet ink';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "DealSigner_surety_wet_ink" BEFORE INSERT OR UPDATE ON "DealSigner"
 FOR EACH ROW EXECUTE FUNCTION "guardSuretyshipWetInk"();

CREATE FUNCTION "guardIsaCpaSnapshot"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD."status" NOT IN ('DRAFT', 'SUBMITTED')
  AND (NEW."isaCpaApplies" IS DISTINCT FROM OLD."isaCpaApplies" OR NEW."isaCpaRule" IS DISTINCT FROM OLD."isaCpaRule") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approved instalment sale CPA scope is fixed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "AssetFinanceDeal_isa_cpa_snapshot" BEFORE UPDATE ON "AssetFinanceDeal"
 FOR EACH ROW EXECUTE FUNCTION "guardIsaCpaSnapshot"();
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_isa_cpa_scope" CHECK (
 ("isaCpaApplies" IS NULL AND "isaCpaRule" IS NULL) OR
 ("contractType" = 'INSTALMENT_SALE' AND "isaCpaApplies" IS NOT NULL AND "isaCpaRule" IS NOT NULL
 AND "isaCpaRule" IN ('CPA_NATURAL_PERSON','CPA_FINANCIALS_UNPROVEN','CPA_JURISTIC_UNDER_THRESHOLD','CPA_JURISTIC_OVER_THRESHOLD')
 AND "isaCpaApplies" = ("isaCpaRule" <> 'CPA_JURISTIC_OVER_THRESHOLD')));

CREATE FUNCTION "guardSuretyConsentEvidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "SuretyConsent" WHERE "evidenceDocumentId" = OLD."id") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A verified spouse consent document is immutable';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "EntityDocument_surety_consent_evidence" BEFORE UPDATE OR DELETE ON "EntityDocument"
 FOR EACH ROW EXECUTE FUNCTION "guardSuretyConsentEvidence"();

ALTER TABLE "SuretyConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SuretyConsent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "SuretyConsent"
 USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant())
 WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
