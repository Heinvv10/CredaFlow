ALTER TABLE "LoanApplication" ADD COLUMN "ncaRepresentativeClientId" TEXT;
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_ncaRepresentativeClientId_fkey"
  FOREIGN KEY ("tenantId", "ncaRepresentativeClientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_nca_representative_scope" CHECK (
  "ncaRepresentativeClientId" IS NULL OR ("clientId" IS NULL AND "entityId" IS NOT NULL AND "ncaRegime" = 'NCA')
);

CREATE OR REPLACE FUNCTION public."guardLoanApplicationTenantBinding"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."clientId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Client" client WHERE client."id" = NEW."clientId" AND client."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Loan application client must belong to the application tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "LoanProduct" product WHERE product."id" = NEW."productId" AND product."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Loan application product must belong to the application tenant';
  END IF;
  IF NEW."status" IN ('APPROVED','DISBURSED') AND NEW."pasqDocumentId" IS NOT NULL
    AND NOT (EXISTS (SELECT 1 FROM "ClientDocument" d WHERE d."id"=NEW."pasqDocumentId" AND d."tenantId"=NEW."tenantId" AND d."clientId"=NEW."clientId" AND d."docType"='FORM_20_PRE_AGREEMENT' AND d."deletedAt" IS NULL)
      OR (NEW."entityId" IS NOT NULL AND NEW."ncaRegime"='NCA' AND EXISTS (SELECT 1 FROM "EntityDocument" d WHERE d."id"=NEW."pasqDocumentId" AND d."tenantId"=NEW."tenantId" AND d."entityId"=NEW."entityId" AND d."docType"='OTHER' AND d."deletedAt" IS NULL))) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Loan application PASQ must belong to the application tenant and borrower';
  END IF;
  RETURN NEW;
END;
$function$;

-- Keep the consumer CHECK exactly as installed, adding only a separately
-- trigger-enforced entity-NCA branch. This avoids copying or weakening its
-- long expression and leaves the consumer result unchanged.
DO $body$
DECLARE definition TEXT; expression TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='"LoanApplication"'::regclass AND conname='LoanApplication_' || 'approved_status_requires_pasq';
  expression := substring(definition FROM 8 FOR char_length(definition)-18);
  EXECUTE 'ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_' || 'approved_status_requires_pasq"';
  EXECUTE 'ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_' || 'approved_status_requires_pasq" CHECK (('
    || expression || ') OR ("entityId" IS NOT NULL AND "ncaRegime" = ''NCA'' AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL)) NOT VALID';
END;
$body$;

CREATE OR REPLACE FUNCTION public."guardAssetEntityNcaApplication"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE expected_provider TEXT; expected_consumer TEXT; expected_envelope TEXT;
BEGIN
  IF NEW."entityId" IS NULL OR NEW."ncaRegime" IS DISTINCT FROM 'NCA' THEN RETURN NEW; END IF;
  IF NEW."status" IN ('APPROVED','DISBURSED') AND (NEW."approvedAt" IS NULL OR NEW."approvedById" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='An entity NCA application requires approval attribution';
  END IF;
  IF NEW."ncaRepresentativeClientId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EntityRelationship" r WHERE r."tenantId"=NEW."tenantId" AND r."entityId"=NEW."entityId"
      AND r."clientId"=NEW."ncaRepresentativeClientId" AND r."active" AND r."role" IN ('DIRECTOR','MEMBER','TRUSTEE','AUTHORISED_SIGNATORY')
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The entity NCA representative must hold current signing authority'; END IF;
  IF NEW."creditLifeElection" IS NOT NULL THEN
    IF NEW."ncaRepresentativeClientId" IS NULL OR NEW."creditLifeElection" <> 'DECLINED'
      OR NEW."creditLifeDisclosureAcknowledgedBy" IS DISTINCT FROM NEW."ncaRepresentativeClientId" THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA credit life is offered and declined by its authorised representative';
    END IF;
  END IF;
  IF NEW."pasqDocumentId" IS NOT NULL OR NEW."status"='DISBURSED' OR NEW."agreementGeneratedAt" IS NOT NULL THEN
    IF NEW."ncaRepresentativeClientId" IS NULL OR NEW."pasqVersion" IS DISTINCT FROM 'pasq-v3'
      OR NEW."pasqDocumentSha256" !~ '^[0-9a-f]{64}$' OR NEW."pasqEvidenceSha256" !~ '^[0-9a-f]{64}$'
      OR NEW."pasqEvidence"->>'tenantId' IS DISTINCT FROM NEW."tenantId"
      OR NEW."pasqEvidence"->>'applicationId' IS DISTINCT FROM NEW."id"
      OR NEW."pasqEvidence"->>'clientId' IS DISTINCT FROM NEW."ncaRepresentativeClientId"
      OR NEW."pasqEvidence"->>'productId' IS DISTINCT FROM NEW."productId"
      OR NEW."pasqEvidence"->>'evidenceSha256' IS DISTINCT FROM NEW."pasqEvidenceSha256"
      OR "pasqEvidenceSha256V3"(NEW."pasqEvidence") IS DISTINCT FROM NEW."pasqEvidenceSha256"
      OR NOT "pasqCreditLifeMatchesApplication"(NEW."pasqEvidence",NEW."creditLifeElection"::text,NEW."creditLifeProductId",NEW."creditLifeProductName",NEW."creditLifeInsurerId",NEW."creditLifeInsurerName",NEW."creditLifeMonthlyPremiumCents",NEW."creditLifeDisclosureVersion",NEW."creditLifeDisclosureSha256",NEW."creditLifeDisclosureAcknowledgedAt",NEW."creditLifeDisclosureAcknowledgedBy",NEW."ncaRepresentativeClientId",NEW."appliedAmount",NEW."appliedTermDays",NEW."pasqGeneratedAt")
      OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d WHERE d."id"=NEW."pasqDocumentId" AND d."tenantId"=NEW."tenantId"
        AND d."entityId"=NEW."entityId" AND d."dealId"=(SELECT af."id" FROM "AssetFinanceDeal" af WHERE af."applicationId"=NEW."id")
        AND d."docType"='OTHER' AND d."deletedAt" IS NULL AND d."contentSha256"=NEW."pasqDocumentSha256")
    THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA quotation evidence must be intact and bound to its representative'; END IF;
  END IF;
  IF NEW."pasqAcknowledgedAt" IS NOT NULL OR NEW."status"='DISBURSED' OR NEW."agreementGeneratedAt" IS NOT NULL THEN
    IF NEW."pasqAcknowledgedAt" IS NULL OR NEW."pasqAcknowledgedAt" < NEW."pasqGeneratedAt"
      OR NEW."pasqAcknowledgedBy" IS DISTINCT FROM NEW."ncaRepresentativeClientId"
      OR NEW."pasqAcknowledgedSha256" IS DISTINCT FROM NEW."pasqDocumentSha256"
      OR NEW."approvedPasqDocumentSha256" IS DISTINCT FROM NEW."pasqDocumentSha256"
    THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA quotation must be acknowledged by its representative'; END IF;
  END IF;
  IF NEW."agreementGeneratedAt" IS NOT NULL OR NEW."status"='DISBURSED' THEN
    IF NEW."agreementDocumentSha256" !~ '^[0-9a-f]{64}$' OR NOT EXISTS (
      SELECT 1 FROM "DealSigner" s JOIN "AssetFinanceDeal" af ON af."id"=s."dealId"
      WHERE af."applicationId"=NEW."id" AND s."id"=NEW."agreementDocumentId" AND s."clientId"=NEW."ncaRepresentativeClientId"
        AND s."document"='AGREEMENT' AND s."documentSha256"=NEW."agreementDocumentSha256"
    ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA agreement must be bound to its representative signer row'; END IF;
  END IF;
  IF NEW."agreementCountersignedAt" IS NOT NULL OR NEW."status"='DISBURSED' THEN
    expected_provider := encode(sha256(convert_to(NEW."agreementCountersignatureData",'UTF8')),'hex');
    expected_consumer := encode(sha256(convert_to(NEW."agreementSignatureData",'UTF8')),'hex');
    expected_envelope := "providerCountersignEnvelopeSha256"(NEW."tenantId",NEW."id",NEW."ncaRepresentativeClientId",NEW."agreementDocumentSha256",NEW."agreementSignedAt",NEW."agreementSignedMethod",NEW."ncaRepresentativeClientId",expected_consumer,NEW."agreementCountersignedAt",NEW."agreementCountersignedById",NEW."agreementCountersignedByName",NEW."agreementCountersignedByEmail",expected_provider);
    IF NEW."agreementSignedAt" IS NULL OR NEW."agreementSignedMethod" IS DISTINCT FROM 'portal' OR length(btrim(NEW."agreementSignatureData"))=0
      OR NEW."agreementCountersignedById" IS NULL OR NEW."agreementCountersignedByName" IS NULL OR NEW."agreementCountersignedByEmail" IS NULL
      OR NEW."agreementCountersignatureSha256" IS DISTINCT FROM expected_provider
      OR NEW."agreementCountersignatureEnvelopeSha256" IS DISTINCT FROM expected_envelope
      OR NEW."agreementCountersignedDocumentSha256" IS DISTINCT FROM NEW."agreementDocumentSha256"
    THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA disbursement requires representative and provider signatures bound to the agreement'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD."ncaRepresentativeClientId" IS NOT NULL AND NEW."ncaRepresentativeClientId" IS DISTINCT FROM OLD."ncaRepresentativeClientId" THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The entity NCA representative is immutable once recorded';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER "LoanApplication_guard_pasq_update" ON "LoanApplication";
CREATE TRIGGER "LoanApplication_guard_pasq_update" BEFORE UPDATE OF status,"approvedAt","approvedById","pasqVersion","pasqGeneratedAt","pasqDocumentId","pasqDocumentSha256","pasqEvidence","pasqEvidenceSha256","pasqAcknowledgedAt","pasqAcknowledgedBy","pasqAcknowledgedSha256","approvedPasqDocumentSha256","agreementGeneratedAt","agreementSignedAt","agreementCountersignedAt","creditLifeElection","creditLifeProductId","creditLifeProductName","creditLifeInsurerId","creditLifeInsurerName","creditLifeMonthlyPremiumCents","creditLifeDisclosureVersion","creditLifeDisclosureSha256","creditLifeDisclosureAcknowledgedAt","creditLifeDisclosureAcknowledgedBy" ON "LoanApplication" FOR EACH ROW WHEN (NEW."entityId" IS NULL OR NEW."ncaRegime" IS DISTINCT FROM 'NCA') EXECUTE FUNCTION "guardLoanApplicationPasqApproval"();
DROP TRIGGER "LoanApplication_guard_provider_countersign_update" ON "LoanApplication";
CREATE TRIGGER "LoanApplication_guard_provider_countersign_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN ((((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) AND (NEW."entityId" IS NULL OR NEW."ncaRegime" IS DISTINCT FROM 'NCA')) EXECUTE FUNCTION "guardLoanApplicationProviderCountersign"();
DROP TRIGGER "LoanApplication_h_lock_credit_life_offer_on_update" ON "LoanApplication";
CREATE TRIGGER "LoanApplication_h_lock_credit_life_offer_on_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (NEW."entityId" IS NULL OR NEW."ncaRegime" IS DISTINCT FROM 'NCA') EXECUTE FUNCTION "guardLoanApplicationCreditLifeOffer"();
CREATE TRIGGER "LoanApplication_asset_entity_nca_guard" BEFORE INSERT OR UPDATE ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardAssetEntityNcaApplication"();
