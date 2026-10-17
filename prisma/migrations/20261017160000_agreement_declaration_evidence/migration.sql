-- Legal-review candidate: code and evidence storage ship together, never migration alone.
CREATE TABLE "AgreementDeclarationAcceptance" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "signerId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "setSha256" TEXT NOT NULL,
  "acceptedIds" TEXT[] NOT NULL,
  "signedAt" TIMESTAMP(3) NOT NULL,
  "agreementDocumentSha256" TEXT NOT NULL,
  "pasqDocumentSha256" TEXT NOT NULL,
  "signatureSha256" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgreementDeclarationAcceptance_application_fkey" FOREIGN KEY ("tenantId", "applicationId", "clientId") REFERENCES "LoanApplication"("tenantId", "id", "clientId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AgreementDeclarationAcceptance_set_check" CHECK (
    "method" = 'portal' AND "version" = 'portal-agreement-declarations-v1'
    AND "setSha256" = '94948b549e9415944b73909f0dce298c5b304e8ed4f832de4e14787e5452cfd7'
    AND "acceptedIds" = ARRAY['pasq_read','schedule_read','settlement_right','terms_accepted','information_true']::TEXT[]
    AND "signerId" = "clientId"
    AND "agreementDocumentSha256" ~ '^[0-9a-f]{64}$'
    AND "pasqDocumentSha256" ~ '^[0-9a-f]{64}$'
    AND "signatureSha256" ~ '^[0-9a-f]{64}$'
  )
);
CREATE UNIQUE INDEX "AgreementDeclarationAcceptance_ceremony_key" ON "AgreementDeclarationAcceptance" ("tenantId", "applicationId", "signedAt", "signatureSha256");
CREATE INDEX "AgreementDeclarationAcceptance_tenantId_applicationId_idx" ON "AgreementDeclarationAcceptance" ("tenantId", "applicationId");
CREATE FUNCTION "guardAgreementDeclarationAcceptance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE application "LoanApplication";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Recorded agreement declaration acceptance is immutable';
  END IF;
  SELECT * INTO application FROM "LoanApplication" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."applicationId" AND "clientId" = NEW."clientId" FOR SHARE;
  IF application."id" IS NULL
    OR application."agreementSignedMethod" IS DISTINCT FROM 'portal'
    OR application."agreementSignedAt" IS DISTINCT FROM NEW."signedAt"
    OR application."agreementDocumentSha256" IS DISTINCT FROM NEW."agreementDocumentSha256"
    OR application."pasqDocumentSha256" IS DISTINCT FROM NEW."pasqDocumentSha256"
    OR application."agreementSignatureData" IS NULL
    OR encode(sha256(convert_to(application."agreementSignatureData", 'UTF8')), 'hex') IS DISTINCT FROM NEW."signatureSha256"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Agreement declaration acceptance must bind the current portal signature and documents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AgreementDeclarationAcceptance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AgreementDeclarationAcceptance" FOR EACH ROW EXECUTE FUNCTION "guardAgreementDeclarationAcceptance"();
