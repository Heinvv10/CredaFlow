-- The offer letter and the arrears letter of a key-facts loan (lib/non-nca-documents; Lesotho
-- PostBank tender items 2.4.3 and 2.7), and Section 129 made unreachable on one in the database.
--
-- 1. OFFER_LETTER joins the issued documents: issued with the key facts statement and the loan
--    agreement from its own approved template, accepted by the borrower on its exact bytes. The
--    signature and the payout gate (guardLoanApplicationKeyFactsDocuments) need it as they need
--    the key facts statement. Enforcement, so it ships with the code that issues it.
-- 2. LoanArrearsLetter: one row per letter, pinned to the template version and its wording. Only a
--    key-facts loan has one, from the current version of the lender's template approved by
--    someone other than its author. Immutable, the SAMPLE flag derived, one per loan per SAST day.
-- 3. A SECTION_129_NOTICE record is refused for a loan of a key-facts application, whatever the
--    application code believes about the jurisdiction. A ZA instance's loans are NCA_PASQ and
--    pass through. Nothing else about a ZA loan changes.
--
-- The new enum value is not usable in this migration's transaction, so the CHECKs compare text.
--
-- Rollback (hand-written): restore the three functions from 20261030090000_non_nca_documents, restore
-- the two CHECKs there, DROP TRIGGER / FUNCTION for the objects below, DROP TABLE "LoanArrearsLetter".
-- The enum value stays (Postgres cannot drop one); nothing references it once the CHECK is back.

ALTER TYPE "LoanDocumentKind" ADD VALUE 'OFFER_LETTER' BEFORE 'KEY_FACTS_STATEMENT';

ALTER TABLE "LoanDocumentIssuance" DROP CONSTRAINT "LoanDocumentIssuance_kind_template_key";
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_kind_template_key" CHECK (
  ("kind"::text = 'KEY_FACTS_STATEMENT' AND "templateKey" = 'non_nca_key_facts')
  OR ("kind"::text = 'LOAN_AGREEMENT' AND "templateKey" = 'non_nca_loan_agreement')
  OR ("kind"::text = 'OFFER_LETTER' AND "templateKey" = 'non_nca_offer_letter')
);
ALTER TABLE "LoanDocumentIssuance" DROP CONSTRAINT "LoanDocumentIssuance_acknowledgement_shape";
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_acknowledgement_shape" CHECK (
  ("acknowledgedAt" IS NULL AND "acknowledgedById" IS NULL AND "acknowledgedSha256" IS NULL)
  OR ("kind"::text IN ('KEY_FACTS_STATEMENT', 'OFFER_LETTER') AND "acknowledgedAt" IS NOT NULL AND "acknowledgedById" IS NOT NULL
      AND length(btrim("acknowledgedById")) > 0 AND "acknowledgedSha256" = "pdfSha256")
);

-- The keyed templates: the offer letter and the arrears letter join the two the rule already covers.
CREATE OR REPLACE FUNCTION public."guardLoanDocumentTemplate"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  keyed constant text[] := ARRAY['non_nca_key_facts', 'non_nca_loan_agreement', 'non_nca_offer_letter', 'non_nca_arrears_letter'];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."key" IS DISTINCT FROM OLD."key" AND (OLD."key" = ANY (keyed) OR NEW."key" = ANY (keyed)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The key of a key facts or loan agreement template cannot be changed';
  END IF;
  IF NOT (NEW."key" = ANY (keyed)) THEN
    RETURN NEW;
  END IF;
  IF NEW."kind" <> 'CUSTOM' OR NOT NEW."requiresApproval" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A key facts or loan agreement template is a custom template whose versions need approval by a second person';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A key facts or loan agreement template cannot be deleted; deactivate it instead';
  END IF;
  RETURN NEW;
END;
$function$;

-- The signature and the payout need an accepted offer letter too. Everything else as it stood.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationKeyFactsDocuments"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  signing boolean;
  disbursing boolean;
  previous_bypass text;
  problem text;
  offer record;
  kfs record;
  agreement record;
  terms text;
BEGIN
  IF NEW."disclosureRegime" <> 'KEY_FACTS' THEN
    RETURN NEW;
  END IF;
  signing := NEW."agreementSignedAt" IS NOT NULL AND OLD."agreementSignedAt" IS NULL;
  disbursing := NEW."status"::text = 'DISBURSED' AND OLD."status"::text <> 'DISBURSED';
  IF NOT signing AND NOT disbursing THEN
    RETURN NEW;
  END IF;

  IF disbursing AND NEW."agreementSignedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan cannot be disbursed before the borrower has signed the loan agreement';
  END IF;

  problem := public."loanDocumentProblem"(NEW."id", 'KEY_FACTS_STATEMENT', signing);
  IF problem IS NULL THEN
    problem := public."loanDocumentProblem"(NEW."id", 'LOAN_AGREEMENT', signing);
  END IF;
  IF problem IS NULL THEN
    problem := public."loanDocumentProblem"(NEW."id", 'OFFER_LETTER', signing);
  END IF;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A loan without a key facts statement and a loan agreement from an approved template cannot be ' || CASE WHEN signing THEN 'signed' ELSE 'disbursed' END || ': ' || problem;
  END IF;

  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT * INTO offer FROM public."LoanDocumentIssuance" WHERE "applicationId" = NEW."id" AND "kind" = 'OFFER_LETTER' AND "supersededAt" IS NULL;
  SELECT * INTO kfs FROM public."LoanDocumentIssuance" WHERE "applicationId" = NEW."id" AND "kind" = 'KEY_FACTS_STATEMENT' AND "supersededAt" IS NULL;
  SELECT * INTO agreement FROM public."LoanDocumentIssuance" WHERE "applicationId" = NEW."id" AND "kind" = 'LOAN_AGREEMENT' AND "supersededAt" IS NULL;
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);

  IF kfs."acknowledgedAt" IS NULL OR kfs."acknowledgedSha256" IS DISTINCT FROM kfs."pdfSha256" OR kfs."acknowledgedById" IS DISTINCT FROM NEW."clientId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The key facts statement has not been acknowledged by the borrower';
  END IF;
  IF signing AND kfs."acknowledgedAt" > NEW."agreementSignedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The key facts statement must be acknowledged before the loan agreement is signed';
  END IF;
  IF offer."acknowledgedAt" IS NULL OR offer."acknowledgedSha256" IS DISTINCT FROM offer."pdfSha256" OR offer."acknowledgedById" IS DISTINCT FROM NEW."clientId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The offer letter has not been accepted by the borrower';
  END IF;
  IF signing AND offer."acknowledgedAt" > NEW."agreementSignedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The offer letter must be accepted before the loan agreement is signed';
  END IF;
  IF agreement."clientDocumentId" IS DISTINCT FROM NEW."agreementDocumentId" OR agreement."pdfSha256" IS DISTINCT FROM NEW."agreementDocumentSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The agreement being signed is not the issued loan agreement';
  END IF;
  -- The terms of THIS statement's new row: a single UPDATE that changes them and signs is judged on what it writes.
  terms := public."loanApplicationTermsSha256"(NEW);
  IF kfs."termsSha256" <> terms OR agreement."termsSha256" <> kfs."termsSha256" OR offer."termsSha256" <> kfs."termsSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The approved terms changed after the documents were issued; issue them again';
  END IF;
  RETURN NEW;
END;
$function$;

-- An arrears letter's file is kept as the issued loan documents' files are.
CREATE OR REPLACE FUNCTION public."guardLoanDocumentFile"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  referenced boolean;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  referenced := EXISTS (SELECT 1 FROM public."LoanDocumentIssuance" WHERE "clientDocumentId" = OLD."id")
    OR EXISTS (SELECT 1 FROM public."LoanArrearsLetter" WHERE "clientDocumentId" = OLD."id");
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF NOT referenced THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document issued as a key facts statement or loan agreement cannot be deleted';
  END IF;
  IF NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document issued as a key facts statement or loan agreement cannot be deleted';
  END IF;
  IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath" OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."issuedForApplicationId" IS DISTINCT FROM OLD."issuedForApplicationId" OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."generatedFromVersionId" IS DISTINCT FROM OLD."generatedFromVersionId" OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The file of an issued key facts statement or loan agreement cannot be replaced';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE "LoanArrearsLetter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "templateVersionNumber" INTEGER NOT NULL,
    "templateContentSha256" TEXT NOT NULL,
    "clientDocumentId" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT false,
    "noticeDate" DATE NOT NULL,
    "arrearsAmount" INTEGER NOT NULL,
    "totalOutstanding" INTEGER NOT NULL,
    "daysInArrears" INTEGER NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT NOT NULL,

    CONSTRAINT "LoanArrearsLetter_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LoanArrearsLetter_hashes_format" CHECK ("templateContentSha256" ~ '^[0-9a-f]{64}$' AND "pdfSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "LoanArrearsLetter_figures" CHECK ("arrearsAmount" > 0 AND "totalOutstanding" >= "arrearsAmount" AND "daysInArrears" > 0)
);

CREATE UNIQUE INDEX "LoanArrearsLetter_clientDocumentId_key" ON "LoanArrearsLetter"("clientDocumentId");
CREATE UNIQUE INDEX "LoanArrearsLetter_tenantId_id_key" ON "LoanArrearsLetter"("tenantId", "id");
CREATE UNIQUE INDEX "LoanArrearsLetter_tenantId_loanId_noticeDate_key" ON "LoanArrearsLetter"("tenantId", "loanId", "noticeDate");
CREATE INDEX "LoanArrearsLetter_tenantId_idx" ON "LoanArrearsLetter"("tenantId");
CREATE INDEX "LoanArrearsLetter_templateVersionId_idx" ON "LoanArrearsLetter"("templateVersionId");

ALTER TABLE "LoanArrearsLetter" ADD CONSTRAINT "LoanArrearsLetter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoanArrearsLetter" ADD CONSTRAINT "LoanArrearsLetter_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanArrearsLetter" ADD CONSTRAINT "LoanArrearsLetter_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "DocumentTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanArrearsLetter" ADD CONSTRAINT "LoanArrearsLetter_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanArrearsLetter" ADD CONSTRAINT "LoanArrearsLetter_tenantId_clientDocumentId_fkey" FOREIGN KEY ("tenantId", "clientDocumentId") REFERENCES "ClientDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LoanArrearsLetter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoanArrearsLetter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "LoanArrearsLetter" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

CREATE OR REPLACE FUNCTION public."guardLoanArrearsLetter"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  regime text;
  loan_client text;
  v public."DocumentTemplateVersion";
  t public."DocumentTemplate";
  doc record;
  demo boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An arrears letter that was issued cannot be changed or deleted';
  END IF;
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT a."disclosureRegime"::text, l."clientId" INTO regime, loan_client
    FROM public."Loan" l JOIN public."LoanApplication" a ON a."id" = l."applicationId" WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT * INTO v FROM public."DocumentTemplateVersion" WHERE "id" = NEW."templateVersionId";
  SELECT * INTO t FROM public."DocumentTemplate" WHERE "id" = NEW."templateId";
  SELECT "clientId", "tenantId", "contentSha256", "generatedFromVersionId", "deletedAt" INTO doc FROM public."ClientDocument" WHERE "id" = NEW."clientDocumentId";
  SELECT coalesce("isDemoLender", false) INTO demo FROM public."TenantConfig" WHERE "tenantId" = NEW."tenantId";
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF regime IS DISTINCT FROM 'KEY_FACTS' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An arrears letter belongs to a key-facts loan; a South African loan has its Section 129 notice';
  END IF;
  IF t."key" IS DISTINCT FROM 'non_nca_arrears_letter' OR v."templateId" IS DISTINCT FROM NEW."templateId" OR v."version" IS DISTINCT FROM NEW."templateVersionNumber" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The letter does not match its template version';
  END IF;
  IF t."kind" <> 'CUSTOM' OR t."deletedAt" IS NOT NULL OR NOT t."isActive" OR t."currentVersionId" IS DISTINCT FROM v."id" OR v."status" <> 'ACTIVE' OR NOT public."loanTemplateVersionApproved"(v) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An arrears letter is issued from the current version of its template, approved by someone other than its author';
  END IF;
  IF encode(sha256(convert_to(v."bodyHtml", 'UTF8')), 'hex') <> NEW."templateContentSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The letter does not carry the wording of its template version';
  END IF;
  IF doc."clientId" IS DISTINCT FROM loan_client OR doc."tenantId" IS DISTINCT FROM NEW."tenantId" OR doc."deletedAt" IS NOT NULL
     OR doc."contentSha256" IS DISTINCT FROM NEW."pdfSha256" OR doc."generatedFromVersionId" IS DISTINCT FROM NEW."templateVersionId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The letter does not match the document rendered from that template version for this borrower';
  END IF;
  NEW."sample" := coalesce(demo, false);
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanArrearsLetter_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LoanArrearsLetter" FOR EACH ROW EXECUTE FUNCTION public."guardLoanArrearsLetter"();

-- Section 129 is NCA-only. The application code refuses it by jurisdiction; this is the regime's own floor.
CREATE OR REPLACE FUNCTION public."guardSection129KeyFacts"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  key_facts boolean;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  key_facts := EXISTS (
    SELECT 1 FROM public."Loan" l JOIN public."LoanApplication" a ON a."id" = l."applicationId"
    WHERE l."id" = NEW."referenceId" AND a."disclosureRegime" = 'KEY_FACTS'
  );
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF key_facts THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Section 129 applies under the South African National Credit Act only: a key-facts loan has an arrears letter';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ComplianceRecord_guard_section129_key_facts" BEFORE INSERT OR UPDATE OF "type", "referenceId" ON "ComplianceRecord" FOR EACH ROW WHEN (NEW."type"::text = 'SECTION_129_NOTICE') EXECUTE FUNCTION public."guardSection129KeyFacts"();
