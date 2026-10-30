-- Non-NCA loan documents (lib/non-nca-documents; Lesotho PostBank tender items
-- 2.2.4 and 2.4.3). An application of a jurisdiction without the NCA is governed
-- by a key facts statement and a loan agreement rendered from the lender's own
-- versioned templates, not by the PASQ.
--
-- 1. LoanApplication.disclosureRegime (NCA_PASQ | KEY_FACTS): set at INSERT from
--    InstanceJurisdiction (KEY_FACTS unless the instance is ZA) by a trigger that
--    overrides whatever the writer sent, and never changed afterwards. Every
--    existing row is NCA_PASQ, and so is every row of a ZA instance.
-- 2. The PASQ rules that already step aside for a NON_NCA (juristic) application
--    also step aside for KEY_FACTS: guardLoanApplicationCreditLifeOffer,
--    lockLoanApplicationPasqDocument, guardLoanApplicationPasqApproval,
--    guardLoanApplicationProviderCountersign (each gets ONE extra OR on its
--    existing early return; nothing else of them changes), assertDisbursedCreditLifeCoverage
--    (one extra early return after its commit-together rule, which KEY_FACTS keeps) and the CHECK
--    LoanApplication_approved_status_requires_pasq (the old expression is kept
--    whole as the first branch, so every NCA_PASQ row is judged exactly as before).
-- 3. LoanDocumentIssuance: one row per issued key facts statement / loan
--    agreement, pinned to the template version and the hash of its wording.
--    guardLoanDocumentIssuance keeps it immutable; the SAMPLE flag is derived from
--    TenantConfig.isDemoLender, never posted.
-- 4. guardLoanApplicationKeyFactsDocuments is the gate. A KEY_FACTS application's
--    borrower signature is refused unless BOTH documents are issued from a template
--    version that is still the template's current ACTIVE, approved version with the
--    wording it was rendered from, the key facts statement was acknowledged by the
--    borrower on exactly those bytes, the agreement is the one being signed, and
--    the approved terms are unchanged. DISBURSED is refused unless the application
--    is signed and the same documents still stand (wording unchanged; a newer
--    template version after signing does not unsign a signed contract).
--
-- Every new function pins search_path to pg_catalog and schema-qualifies (same
-- discipline as 20261029120000_instance_jurisdiction). The guards read with
-- app.rls_bypass on (restored afterwards), so a strict-RLS session cannot make
-- them see no rows.
--
-- Rollback (hand-written; Prisma has no down migrations): restore the four patched
-- functions and the CHECK from 20261009000000_baseline / 20261013090000_asset_finance_foundation,
-- then DROP TRIGGER ... / DROP FUNCTION ... for the objects below, DROP TABLE
-- "LoanDocumentIssuance", DROP COLUMN "LoanApplication"."disclosureRegime", DROP TYPE
-- "LoanDocumentKind", "DisclosureRegime", and delete the migration row.

CREATE TYPE "DisclosureRegime" AS ENUM ('NCA_PASQ', 'KEY_FACTS');

CREATE TYPE "LoanDocumentKind" AS ENUM ('KEY_FACTS_STATEMENT', 'LOAN_AGREEMENT');

ALTER TABLE "LoanApplication" ADD COLUMN "disclosureRegime" "DisclosureRegime" NOT NULL DEFAULT 'NCA_PASQ';

CREATE TABLE "LoanDocumentIssuance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "LoanDocumentKind" NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "templateVersionNumber" INTEGER NOT NULL,
    "templateContentSha256" TEXT NOT NULL,
    "clientDocumentId" TEXT NOT NULL,
    "pdfSha256" TEXT NOT NULL,
    "termsSha256" TEXT NOT NULL,
    "sample" BOOLEAN NOT NULL DEFAULT false,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgedSha256" TEXT,

    CONSTRAINT "LoanDocumentIssuance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanDocumentIssuance_tenantId_applicationId_idx" ON "LoanDocumentIssuance"("tenantId", "applicationId");
CREATE INDEX "LoanDocumentIssuance_templateVersionId_idx" ON "LoanDocumentIssuance"("templateVersionId");
CREATE UNIQUE INDEX "LoanDocumentIssuance_tenantId_id_key" ON "LoanDocumentIssuance"("tenantId", "id");
-- One standing document of each kind per application.
CREATE UNIQUE INDEX "LoanDocumentIssuance_one_standing_idx" ON "LoanDocumentIssuance"("applicationId", "kind") WHERE "supersededAt" IS NULL;

ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "DocumentTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_tenantId_clientDocumentId_fkey" FOREIGN KEY ("tenantId", "clientDocumentId") REFERENCES "ClientDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_hashes_format" CHECK (
  "templateContentSha256" ~ '^[0-9a-f]{64}$' AND "pdfSha256" ~ '^[0-9a-f]{64}$' AND "termsSha256" ~ '^[0-9a-f]{64}$'
  AND ("acknowledgedSha256" IS NULL OR "acknowledgedSha256" ~ '^[0-9a-f]{64}$')
);
-- The template key names the document: one key per kind.
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_kind_template_key" CHECK (
  ("kind" = 'KEY_FACTS_STATEMENT' AND "templateKey" = 'non_nca_key_facts')
  OR ("kind" = 'LOAN_AGREEMENT' AND "templateKey" = 'non_nca_loan_agreement')
);
-- An acknowledgement is whole, and only a key facts statement has one.
ALTER TABLE "LoanDocumentIssuance" ADD CONSTRAINT "LoanDocumentIssuance_acknowledgement_shape" CHECK (
  ("acknowledgedAt" IS NULL AND "acknowledgedById" IS NULL AND "acknowledgedSha256" IS NULL)
  OR ("kind" = 'KEY_FACTS_STATEMENT' AND "acknowledgedAt" IS NOT NULL AND "acknowledgedById" IS NOT NULL
      AND length(btrim("acknowledgedById")) > 0 AND "acknowledgedSha256" = "pdfSha256")
);

-- The PASQ rules step aside for KEY_FACTS exactly as they already do for NON_NCA: ONE extra OR on
-- each early return, the rest of each function as it stands.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationCreditLifeOffer"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_product_id TEXT;
  entering_approved_state BOOLEAN;
BEGIN
  -- Credit life (Reg. 2017) attaches to NCA credit agreements only.
  IF NEW."ncaRegime" = 'NON_NCA' OR NEW."disclosureRegime" = 'KEY_FACTS' THEN
    RETURN NEW;
  END IF;
  entering_approved_state :=
    NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND (
      TG_OP = 'INSERT'
      OR OLD."status"::TEXT NOT IN ('APPROVED', 'DISBURSED')
      OR (
        OLD."status"::TEXT <> 'DISBURSED'
        AND NEW."status"::TEXT = 'DISBURSED'
      )
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeProductName"
        IS DISTINCT FROM OLD."creditLifeProductName"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeInsurerName"
        IS DISTINCT FROM OLD."creditLifeInsurerName"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."creditLifeDisclosureVersion"
        IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
      OR NEW."creditLifeDisclosureSha256"
        IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
      OR NEW."creditLifeDisclosureAcknowledgedAt"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      OR NEW."creditLifeDisclosureAcknowledgedBy"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
      -- The no-offer branch below reads the amounts, so a change to either
      -- on an approved row is re-checked too.
      OR NEW."appliedAmount" IS DISTINCT FROM OLD."appliedAmount"
      OR NEW."approvedAmount" IS DISTINCT FROM OLD."approvedAmount"
    );

  IF NOT entering_approved_state THEN
    RETURN NEW;
  END IF;

  -- No offer was disclosed, so there is no product row to lock. But the row
  -- ASSERTS that no cover was offered, and that has to still be true at
  -- approval: if an insurer was onboarded between PASQ generation and here,
  -- the assertion is now false and the application must go back to draft for
  -- a current election. The offered path re-verifies at approval and again at
  -- disbursement; without this the no-offer path verified at neither.
  IF NEW."creditLifeDisclosureVersion" = 'credit-life-no-offer-v1' THEN
    -- Cover cannot be added at or below the R1,000 credit-life threshold
    -- (CREDIT_LIFE_AUTO_BUNDLE_THRESHOLD_CENTS, lib/insurance/credit-life-election.ts),
    -- so an active product is no offer there and "none was offered" stays
    -- true. The larger of the applied and approved amounts decides, so an
    -- approval above the threshold is still refused.
    IF GREATEST(NEW."appliedAmount", COALESCE(NEW."approvedAmount", 0)) > 100000 AND EXISTS (
      SELECT 1
      FROM "InsuranceProduct" AS product
      JOIN "Insurer" AS insurer
        ON insurer."id" = product."insurerId"
        AND insurer."tenantId" = product."tenantId"
      WHERE product."tenantId" = NEW."tenantId"
        AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
        AND product."active" = TRUE
        AND LENGTH(BTRIM(product."name")) > 0
        AND insurer."active" = TRUE
        AND LENGTH(BTRIM(insurer."name")) > 0
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Approval requires a current credit-life election: cover became available after this application recorded that none was offered';
    END IF;
    RETURN NEW;
  END IF;

  SELECT product."id"
  INTO locked_product_id
  FROM "InsuranceProduct" AS product
  JOIN "Insurer" AS insurer
    ON insurer."id" = product."insurerId"
    AND insurer."tenantId" = product."tenantId"
  WHERE product."id" = NEW."creditLifeProductId"
    AND product."tenantId" = NEW."tenantId"
    AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND product."active" = TRUE
    AND product."name" = NEW."creditLifeProductName"
    AND insurer."id" = NEW."creditLifeInsurerId"
    AND insurer."tenantId" = NEW."tenantId"
    AND insurer."active" = TRUE
    AND insurer."name" = NEW."creditLifeInsurerName"
  FOR SHARE OF product, insurer;

  IF locked_product_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires an active tenant-bound credit-life product and insurer matching the acknowledged PASQ';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."lockLoanApplicationPasqDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_document_id TEXT;
BEGIN
  -- The PASQ (NCA s92, Form 20) is an NCA consumer document.
  IF NEW."ncaRegime" = 'NON_NCA' OR NEW."disclosureRegime" = 'KEY_FACTS' THEN
    RETURN NEW;
  END IF;
  IF NEW."status"::TEXT NOT IN ('APPROVED', 'DISBURSED') THEN
    RETURN NEW;
  END IF;

  -- Pre-ceremony: an APPROVED application legitimately carries no quotation
  -- until the ceremony starts, so there is no document to lock yet. Any claimed
  -- binding, any agreement artefact, and every DISBURSED row still must resolve
  -- to an intact bound PDF.
  IF NEW."status"::TEXT = 'APPROVED'
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT document."id"
  INTO locked_document_id
  FROM "ClientDocument" AS document
  WHERE document."id" = NEW."pasqDocumentId"
    AND document."tenantId" = NEW."tenantId"
    AND document."clientId" = NEW."clientId"
    AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
    AND document."deletedAt" IS NULL
    AND document."storagePath" IS NOT NULL
    AND LENGTH(BTRIM(document."storagePath")) > 0
    AND document."mimeType" = 'application/pdf'
    AND document."fileSize" IS NOT NULL
    AND document."fileSize" > 0
    AND document."contentSha256" = NEW."pasqDocumentSha256"
  FOR SHARE;

  IF locked_document_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires an intact locked application-bound PASQ document';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationPasqApproval"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  agreement_exists_old BOOLEAN;
  agreement_exists_new BOOLEAN;
  ceremony_open BOOLEAN;
BEGIN
  -- The PASQ (NCA s92, Form 20) is an NCA consumer document.
  IF NEW."ncaRegime" = 'NON_NCA' OR NEW."disclosureRegime" = 'KEY_FACTS' THEN
    RETURN NEW;
  END IF;
  -- The freeze anchor. `agreementGeneratedAt` alone is not enough: it is
  -- nullable, and nulling it on a SIGNED row used to reopen the ceremony and
  -- let the acknowledged quotation be rewritten underneath the contract the
  -- consumer had already signed. The anchor is therefore the presence of ANY
  -- agreement artefact, and it is read from OLD as well as NEW so that the
  -- retraction cannot be laundered through an intermediate state.
  agreement_exists_new :=
    NEW."agreementGeneratedAt" IS NOT NULL
    OR NEW."agreementSignedAt" IS NOT NULL
    OR NEW."agreementCountersignedAt" IS NOT NULL;

  IF TG_OP = 'UPDATE' THEN
    agreement_exists_old :=
      OLD."agreementGeneratedAt" IS NOT NULL
      OR OLD."agreementSignedAt" IS NOT NULL
      OR OLD."agreementCountersignedAt" IS NOT NULL;
  ELSE
    agreement_exists_old := FALSE;
  END IF;

  explicit_return_to_review :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."creditLifeElection"
      IS NOT DISTINCT FROM OLD."creditLifeElection"
    AND NEW."creditLifeProductId"
      IS NOT DISTINCT FROM OLD."creditLifeProductId"
    AND NEW."creditLifeProductName"
      IS NOT DISTINCT FROM OLD."creditLifeProductName"
    AND NEW."creditLifeInsurerId"
      IS NOT DISTINCT FROM OLD."creditLifeInsurerId"
    AND NEW."creditLifeInsurerName"
      IS NOT DISTINCT FROM OLD."creditLifeInsurerName"
    AND NEW."creditLifeMonthlyPremiumCents"
      IS NOT DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
    AND NEW."creditLifeDisclosureVersion"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureVersion"
    AND NEW."creditLifeDisclosureSha256"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureSha256"
    AND NEW."creditLifeDisclosureAcknowledgedAt"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
    AND NEW."creditLifeDisclosureAcknowledgedBy"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy";

  -- The only window in which PASQ evidence may be written or replaced:
  -- APPROVED, no agreement artefact before or after the write.
  ceremony_open :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'APPROVED'
    AND NOT agreement_exists_old
    AND NOT agreement_exists_new;

  IF TG_OP = 'UPDATE' AND OLD."status"::TEXT IN ('APPROVED', 'DISBURSED') THEN
    IF NEW."status"::TEXT NOT IN ('APPROVED', 'DISBURSED') THEN
      IF NOT explicit_return_to_review THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Approved PASQ evidence may only be invalidated by the explicit return-to-review transition';
      END IF;
    ELSIF agreement_exists_old AND NOT agreement_exists_new THEN
      -- Retracting the anchor is how the ceremony would be reopened under a
      -- contract that already exists. Tearing the agreement down is legal only
      -- through the return-to-review transition above, which also drops the row
      -- out of APPROVED/DISBURSED.
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Agreement artefacts may not be retracted while the application is approved or disbursed; PASQ evidence is immutable once an agreement exists';

    ELSIF (
      -- One-packet ceremony: an unsigned agreement draft already exists and
      -- this exact statement both acknowledges its source PASQ and records the
      -- consumer signature. A standalone staff acknowledgement remains
      -- forbidden after packet preparation.
      TG_OP = 'UPDATE'
      AND OLD."status"::TEXT = 'APPROVED'
      AND NEW."status"::TEXT = 'APPROVED'
      AND OLD."agreementGeneratedAt" IS NOT NULL
      AND NEW."agreementGeneratedAt"
        IS NOT DISTINCT FROM OLD."agreementGeneratedAt"
      AND OLD."agreementSignedAt" IS NULL
      AND OLD."agreementCountersignedAt" IS NULL
      AND NEW."agreementSignedAt" IS NOT NULL
      AND NEW."agreementSignedAt" >= NEW."pasqGeneratedAt"
      AND NEW."agreementCountersignedAt" IS NULL
      AND OLD."pasqAcknowledgedAt" IS NULL
      AND OLD."pasqAcknowledgedBy" IS NULL
      AND OLD."pasqAcknowledgedSha256" IS NULL
      AND OLD."approvedPasqDocumentSha256" IS NULL
      AND NEW."pasqAcknowledgedAt" IS NOT NULL
      AND NEW."pasqAcknowledgedAt" >= NEW."pasqGeneratedAt"
      AND NEW."pasqAcknowledgedBy" = NEW."clientId"
      AND NEW."pasqAcknowledgedSha256" = NEW."pasqDocumentSha256"
      AND NEW."approvedPasqDocumentSha256" = NEW."pasqDocumentSha256"
      AND NEW."pasqVersion" IS NOT DISTINCT FROM OLD."pasqVersion"
      AND NEW."pasqGeneratedAt" IS NOT DISTINCT FROM OLD."pasqGeneratedAt"
      AND NEW."pasqDocumentId" IS NOT DISTINCT FROM OLD."pasqDocumentId"
      AND NEW."pasqDocumentSha256"
        IS NOT DISTINCT FROM OLD."pasqDocumentSha256"
      AND NEW."pasqEvidence" IS NOT DISTINCT FROM OLD."pasqEvidence"
      AND NEW."pasqEvidenceSha256"
        IS NOT DISTINCT FROM OLD."pasqEvidenceSha256"
      AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
      AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
      AND NEW."creditLifeElection"
        IS NOT DISTINCT FROM OLD."creditLifeElection"
      AND NEW."creditLifeProductId"
        IS NOT DISTINCT FROM OLD."creditLifeProductId"
      AND NEW."creditLifeProductName"
        IS NOT DISTINCT FROM OLD."creditLifeProductName"
      AND NEW."creditLifeInsurerId"
        IS NOT DISTINCT FROM OLD."creditLifeInsurerId"
      AND NEW."creditLifeInsurerName"
        IS NOT DISTINCT FROM OLD."creditLifeInsurerName"
      AND NEW."creditLifeMonthlyPremiumCents"
        IS NOT DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      AND NEW."creditLifeDisclosureVersion"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureVersion"
      AND NEW."creditLifeDisclosureSha256"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureSha256"
      AND NEW."creditLifeDisclosureAcknowledgedAt"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      AND NEW."creditLifeDisclosureAcknowledgedBy"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
    ) THEN
      NULL;
    ELSIF ceremony_open THEN
      -- PASQ evidence is being written by the ceremony. Approval attribution
      -- and the credit-life disclosure the quotation restates must still not
      -- move underneath it.
      IF (
        NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
        OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
        OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
        OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
        OR NEW."creditLifeProductName"
          IS DISTINCT FROM OLD."creditLifeProductName"
        OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
        OR NEW."creditLifeInsurerName"
          IS DISTINCT FROM OLD."creditLifeInsurerName"
        OR NEW."creditLifeMonthlyPremiumCents"
          IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
        OR NEW."creditLifeDisclosureVersion"
          IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
        OR NEW."creditLifeDisclosureSha256"
          IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
        OR NEW."creditLifeDisclosureAcknowledgedAt"
          IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
        OR NEW."creditLifeDisclosureAcknowledgedBy"
          IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Approval attribution is immutable after approval; credit-life evidence is immutable after approval';
      END IF;
    ELSIF (
      NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
      OR NEW."pasqVersion" IS DISTINCT FROM OLD."pasqVersion"
      OR NEW."pasqGeneratedAt" IS DISTINCT FROM OLD."pasqGeneratedAt"
      OR NEW."pasqDocumentId" IS DISTINCT FROM OLD."pasqDocumentId"
      OR NEW."pasqDocumentSha256" IS DISTINCT FROM OLD."pasqDocumentSha256"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
      OR NEW."pasqEvidenceSha256" IS DISTINCT FROM OLD."pasqEvidenceSha256"
      OR NEW."pasqAcknowledgedAt" IS DISTINCT FROM OLD."pasqAcknowledgedAt"
      OR NEW."pasqAcknowledgedBy" IS DISTINCT FROM OLD."pasqAcknowledgedBy"
      OR NEW."pasqAcknowledgedSha256"
        IS DISTINCT FROM OLD."pasqAcknowledgedSha256"
      OR NEW."approvedPasqDocumentSha256"
        IS DISTINCT FROM OLD."approvedPasqDocumentSha256"
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeProductName"
        IS DISTINCT FROM OLD."creditLifeProductName"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeInsurerName"
        IS DISTINCT FROM OLD."creditLifeInsurerName"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."creditLifeDisclosureVersion"
        IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
      OR NEW."creditLifeDisclosureSha256"
        IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
      OR NEW."creditLifeDisclosureAcknowledgedAt"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      OR NEW."creditLifeDisclosureAcknowledgedBy"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Approval attribution is immutable after approval; PASQ evidence is immutable after approval; credit-life evidence is immutable after approval';
    END IF;
  END IF;

  IF NEW."status"::TEXT = 'DRAFT' AND (
    NEW."pasqVersion" IS NOT NULL
    OR NEW."pasqGeneratedAt" IS NOT NULL
    OR NEW."pasqDocumentId" IS NOT NULL
    OR NEW."pasqDocumentSha256" IS NOT NULL
    OR NEW."pasqEvidence" IS NOT NULL
    OR NEW."pasqEvidenceSha256" IS NOT NULL
    OR NEW."pasqAcknowledgedAt" IS NOT NULL
    OR NEW."pasqAcknowledgedBy" IS NOT NULL
    OR NEW."pasqAcknowledgedSha256" IS NOT NULL
    OR NEW."approvedPasqDocumentSha256" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Draft applications may not retain PASQ or acknowledgement evidence';
  END IF;

  -- Intact-document requirement. Skipped ONLY for a pre-ceremony APPROVED
  -- application that claims no quotation at all; any claimed binding, any
  -- agreement artefact, and every DISBURSED row must still resolve to an intact
  -- bound PDF.
  IF NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND (
      NEW."status"::TEXT = 'DISBURSED'
      OR agreement_exists_new
      OR NEW."pasqDocumentId" IS NOT NULL
      OR NEW."pasqDocumentSha256" IS NOT NULL
      OR NEW."pasqAcknowledgedAt" IS NOT NULL
      OR NEW."approvedPasqDocumentSha256" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "ClientDocument" AS document
      WHERE document."id" = NEW."pasqDocumentId"
        AND document."tenantId" = NEW."tenantId"
        AND document."clientId" = NEW."clientId"
        AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
        AND document."deletedAt" IS NULL
        AND document."storagePath" IS NOT NULL
        AND LENGTH(BTRIM(document."storagePath")) > 0
        AND document."mimeType" = 'application/pdf'
        AND document."fileSize" IS NOT NULL
        AND document."fileSize" > 0
        AND document."contentSha256" = NEW."pasqDocumentSha256"
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires intact application-bound PASQ document metadata';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationProviderCountersign"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  expected_provider_signature_sha256 TEXT;
  expected_consumer_signature_sha256 TEXT;
  expected_envelope_sha256 TEXT;
BEGIN
  -- Consumer agreement countersign; a NON_NCA deal's signers are enforced by its own signing and payout gate.
  IF NEW."ncaRegime" = 'NON_NCA' OR NEW."disclosureRegime" = 'KEY_FACTS' THEN
    RETURN NEW;
  END IF;
  explicit_return_to_review :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementSignedMethod" IS NULL
    AND NEW."agreementSignedByUserId" IS NULL
    AND NEW."agreementSignatureData" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedById" IS NULL
    AND NEW."agreementCountersignedByName" IS NULL
    AND NEW."agreementCountersignedByEmail" IS NULL
    AND NEW."agreementCountersignatureData" IS NULL
    AND NEW."agreementCountersignatureSha256" IS NULL
    AND NEW."agreementCountersignatureEnvelopeSha256" IS NULL
    AND NEW."agreementCountersignedDocumentSha256" IS NULL;

  IF NEW."agreementCountersignatureData" IS NOT NULL THEN
    expected_provider_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementCountersignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF NEW."agreementSignatureData" IS NOT NULL THEN
    expected_consumer_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementSignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF
    expected_provider_signature_sha256 IS NOT NULL
    AND expected_consumer_signature_sha256 IS NOT NULL
  THEN
    expected_envelope_sha256 := "providerCountersignEnvelopeSha256"(
      NEW."tenantId",
      NEW."id",
      NEW."clientId",
      NEW."agreementDocumentSha256",
      NEW."agreementSignedAt",
      NEW."agreementSignedMethod",
      CASE
        WHEN NEW."agreementSignedMethod" = 'portal' THEN NEW."clientId"
        ELSE NEW."agreementSignedByUserId"
      END,
      expected_consumer_signature_sha256,
      NEW."agreementCountersignedAt",
      NEW."agreementCountersignedById",
      NEW."agreementCountersignedByName",
      NEW."agreementCountersignedByEmail",
      expected_provider_signature_sha256
    );
  END IF;

  IF NEW."status"::TEXT = 'DISBURSED' AND (
    NEW."agreementDocumentSha256" IS NULL
    OR NEW."agreementDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementSignedAt" IS NULL
    OR NEW."agreementSignedMethod" IS NULL
    OR NEW."agreementSignedMethod" NOT IN ('portal', 'branch')
    OR NEW."agreementSignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementSignatureData")) = 0
    OR (
      NEW."agreementSignedMethod" = 'portal'
      AND NEW."agreementSignedByUserId" IS NOT NULL
    )
    OR (
      NEW."agreementSignedMethod" = 'branch'
      AND (
        NEW."agreementSignedByUserId" IS NULL
        OR LENGTH(BTRIM(NEW."agreementSignedByUserId")) = 0
      )
    )
    OR NEW."agreementCountersignedAt" IS NULL
    OR NEW."agreementCountersignedById" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedById")) = 0
    OR NEW."agreementCountersignedByName" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByName")) = 0
    OR NEW."agreementCountersignedByEmail" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByEmail")) = 0
    OR NEW."agreementCountersignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignatureData")) = 0
    OR NEW."agreementCountersignatureSha256"
      IS DISTINCT FROM expected_provider_signature_sha256
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM expected_envelope_sha256
    OR NEW."agreementCountersignedDocumentSha256" IS NULL
    OR NEW."agreementCountersignedDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementCountersignedAt" < NEW."agreementSignedAt"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM NEW."agreementDocumentSha256"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires provider countersign evidence bound to the exact tenant, consumer signature and agreement';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."agreementCountersignedAt" IS NOT NULL AND (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."agreementDocumentId" IS DISTINCT FROM OLD."agreementDocumentId"
    OR NEW."agreementDocumentSha256" IS DISTINCT FROM OLD."agreementDocumentSha256"
    OR NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
    OR NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
    OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
    OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"
    OR NEW."agreementCountersignedAt" IS DISTINCT FROM OLD."agreementCountersignedAt"
    OR NEW."agreementCountersignedById" IS DISTINCT FROM OLD."agreementCountersignedById"
    OR NEW."agreementCountersignedByName" IS DISTINCT FROM OLD."agreementCountersignedByName"
    OR NEW."agreementCountersignedByEmail" IS DISTINCT FROM OLD."agreementCountersignedByEmail"
    OR NEW."agreementCountersignatureData" IS DISTINCT FROM OLD."agreementCountersignatureData"
    OR NEW."agreementCountersignatureSha256" IS DISTINCT FROM OLD."agreementCountersignatureSha256"
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM OLD."agreementCountersignatureEnvelopeSha256"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM OLD."agreementCountersignedDocumentSha256"
  ) AND NOT explicit_return_to_review THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Consumer and provider signature evidence is immutable after provider countersign';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCoverage"(target_application_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_status "AppStatus";
  application_disbursed_at TIMESTAMP(3);
  application_tenant_id TEXT;
  application_client_id TEXT;
  application_entity_id TEXT;
  application_nca_regime "NcaRegime";
  application_disclosure "DisclosureRegime";
  application_rule TEXT;
  loan_id TEXT;
  loan_tenant_id TEXT;
  loan_client_id TEXT;
  loan_entity_id TEXT;
  loan_nca_regime "NcaRegime";
  loan_principal INTEGER;
  loan_start_date TIMESTAMP(3);
  loan_maturity_date TIMESTAMP(3);
  elected_credit_life BOOLEAN;
  bundled_policy_count BIGINT;
  valid_bundled_policy_count BIGINT;
BEGIN
  IF target_application_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    application."status",
    application."disbursedAt",
    application."tenantId",
    application."clientId",
    application."entityId",
    application."ncaRegime",
    application."ncaClassificationRule",
    application."disclosureRegime",
    loan."id",
    loan."tenantId",
    loan."clientId",
    loan."entityId",
    loan."ncaRegime",
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    application_status,
    application_disbursed_at,
    application_tenant_id,
    application_client_id,
    application_entity_id,
    application_nca_regime,
    application_rule,
    application_disclosure,
    loan_id,
    loan_tenant_id,
    loan_client_id,
    loan_entity_id,
    loan_nca_regime,
    loan_principal,
    loan_start_date,
    loan_maturity_date
  FROM "LoanApplication" AS application
  LEFT JOIN "Loan" AS loan
    ON loan."applicationId" = application."id"
  WHERE application."id" = target_application_id
  FOR KEY SHARE OF application;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- An application with no loan and no disbursement is outside this invariant.
  IF loan_id IS NULL
     AND application_status <> 'DISBURSED'::"AppStatus" THEN
    RETURN;
  END IF;

  IF loan_id IS NOT NULL
     AND loan_nca_regime IS DISTINCT FROM COALESCE(application_nca_regime, 'NCA'::"NcaRegime") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A loan''s NCA regime must be its application''s at commit';
  END IF;

  IF loan_nca_regime = 'NON_NCA' AND (
    application_status <> 'DISBURSED'::"AppStatus"
    OR application_disbursed_at IS NULL
    OR loan_tenant_id IS DISTINCT FROM application_tenant_id
    OR (application_rule IS DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT' AND (
      loan_client_id IS NOT NULL OR application_client_id IS NOT NULL OR loan_entity_id IS NULL))
    OR loan_client_id IS DISTINCT FROM application_client_id
    OR loan_entity_id IS DISTINCT FROM application_entity_id
    OR (application_rule = 'LARGE_AGREEMENT' AND loan_principal < 25000000)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A NON_NCA loan commits only with its application DISBURSED, NON_NCA, for the same entity and at a principal its classification allows';
  END IF;

  -- A loan on an application that never reached approval carries no signed
  -- election; seed and fixtures book these. APPROVED stays in scope.
  IF application_status IN ('DRAFT'::"AppStatus", 'SUBMITTED'::"AppStatus", 'UNDER_REVIEW'::"AppStatus") THEN
    RETURN;
  END IF;

  -- A Loan row represents the money path. It and the application transition
  -- must become visible together at commit, regardless of writer version.
  IF loan_id IS NULL
     OR application_status <> 'DISBURSED'::"AppStatus"
     OR application_disbursed_at IS NULL
     OR loan_tenant_id IS DISTINCT FROM application_tenant_id
     OR loan_client_id IS DISTINCT FROM application_client_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan creation and application disbursement must commit together with matching tenant and client evidence';
  END IF;

  -- Credit life attaches to NCA credit agreements only; a NON_NCA (juristic)
  -- deal keeps the commit-together rule above and nothing after it.
  IF application_nca_regime = 'NON_NCA' THEN
    RETURN;
  END IF;

  -- Nor does it attach to a key-facts (non-NCA jurisdiction) application.
  IF application_disclosure = 'KEY_FACTS' THEN
    RETURN;
  END IF;

  IF application_entity_id IS NOT NULL AND application_nca_regime = 'NCA' THEN
    IF loan_entity_id IS DISTINCT FROM application_entity_id OR loan_client_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."id"=target_application_id AND a."creditLifeElection"='DECLINED')
      OR EXISTS (SELECT 1 FROM "InsurancePolicy" p WHERE p."linkedLoanId"=loan_id AND p."type"='CREDIT_LIFE' AND p."policySource"='BUNDLED_CREDIT_AGREEMENT') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA loan requires its matched entity, declined credit life and no bundled policy';
    END IF;
    RETURN;
  END IF;

  elected_credit_life := "resolveCreditLifeElectionForLoan"(
    application_tenant_id,
    application_client_id,
    loan_id
  );

  SELECT COUNT(*)
  INTO bundled_policy_count
  FROM "InsurancePolicy" AS policy
  WHERE policy."linkedLoanId" = loan_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource";

  SELECT COUNT(*)
  INTO valid_bundled_policy_count
  FROM "InsurancePolicy" AS policy
  JOIN "InsuranceProduct" AS product
    ON product."id" = policy."productId"
   AND product."tenantId" = policy."tenantId"
   AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
  WHERE policy."linkedLoanId" = loan_id
    AND policy."tenantId" = application_tenant_id
    AND policy."clientId" = application_client_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
    AND policy."premiumAmount" > 0
    AND policy."sumAssured" > 0
    AND policy."renewalDate" > policy."startDate"
    AND policy."sumAssured" = loan_principal::NUMERIC / 100
    AND policy."premiumAmount" = ROUND((loan_principal::NUMERIC / 100) * 0.0045, 2)
    AND policy."startDate" = loan_start_date
    AND policy."renewalDate" = loan_maturity_date;

  IF elected_credit_life THEN
    IF bundled_policy_count <> 1 OR valid_bundled_policy_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Disbursed loan with elected credit life requires exactly one valid bundled policy';
    END IF;
    PERFORM "assertBundledCreditLifeAgreement"(
      application_tenant_id,
      application_client_id,
      loan_id
    );
  ELSIF bundled_policy_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Disbursed loan without a credit-life election cannot have a bundled policy';
  END IF;
END;
$function$;

ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_approved_status_requires_pasq";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_status_requires_pasq" CHECK (((((((status)::text <> ALL (ARRAY['APPROVED'::text, 'DISBURSED'::text])) OR (((status)::text = 'APPROVED'::text) AND ("agreementSignedAt" IS NULL) AND ("agreementCountersignedAt" IS NULL) AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ((("pasqVersion" IS NULL) AND ("pasqGeneratedAt" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqDocumentSha256" IS NULL) AND ("pasqEvidence" IS NULL) AND ("pasqEvidenceSha256" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt") AND ((("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256")))))) OR (("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND ("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt"))) IS TRUE) OR ((("ncaRegime" = 'NON_NCA'::"NcaRegime") AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) IS TRUE) OR (("entityId" IS NOT NULL) AND ("ncaRegime" = 'NCA'::"NcaRegime") AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL)))) OR (("disclosureRegime" = 'KEY_FACTS'::"DisclosureRegime") AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) IS TRUE) NOT VALID;

-- ---------------------------------------------------------------------------
-- disclosureRegime: set from the instance at INSERT, fixed for life.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."setLoanApplicationDisclosureRegime"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  inst_j text;
BEGIN
  -- No lock and no isolation requirement: holdInstanceJurisdiction (statement trigger, runs first)
  -- holds the instance lock shared and stamps frozenAt, so the row cannot change under this insert
  -- (a stale snapshot is refused there as a write conflict, not read here).
  SELECT "jurisdiction"::text INTO inst_j FROM public."InstanceJurisdiction" WHERE "id" = 1;
  -- A database without the row (not migrated) is South African: the PASQ stays required.
  NEW."disclosureRegime" := CASE WHEN inst_j IS NOT NULL AND inst_j <> 'ZA' THEN 'KEY_FACTS' ELSE 'NCA_PASQ' END::public."DisclosureRegime";
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationDisclosureRegime"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW."disclosureRegime" IS DISTINCT FROM OLD."disclosureRegime" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An application''s disclosure regime is fixed when it is created';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The approved terms, as one hash: what the key facts statement and the agreement
-- print. Computed here so the application that issues a document and the gate that
-- checks it cannot differ.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."loanApplicationTermsSha256"(p_application_id text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  terms jsonb;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT jsonb_build_object(
      'productId', a."productId", 'appliedAmount', a."appliedAmount", 'appliedTermDays', a."appliedTermDays",
      'approvedAmount', a."approvedAmount", 'approvedTermDays', a."approvedTermDays",
      'repaymentMethod', a."repaymentMethod", 'initiationFeePayment', a."initiationFeePayment",
      'affordabilityResult', a."affordabilityResult")
    INTO terms FROM public."LoanApplication" a WHERE a."id" = p_application_id;
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  IF terms IS NULL THEN RETURN NULL; END IF;
  RETURN encode(sha256(convert_to(terms::text, 'UTF8')), 'hex');
END;
$function$;

-- ---------------------------------------------------------------------------
-- Why a standing document does not hold, or NULL when it does.
--   p_require_current: the wording must still be the template's current ACTIVE
--   approved version (signing). Off (disbursement), the signed contract stands on the
--   version it was rendered from, as long as that wording is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."loanDocumentProblem"(p_application_id text, p_kind public."LoanDocumentKind", p_require_current boolean)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  i record;
  v record;
  t record;
  problem text;
BEGIN
  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT * INTO i FROM public."LoanDocumentIssuance" WHERE "applicationId" = p_application_id AND "kind" = p_kind AND "supersededAt" IS NULL;
  IF NOT FOUND THEN
    problem := 'no ' || replace(lower(p_kind::text), '_', ' ') || ' has been issued';
  ELSE
    SELECT * INTO v FROM public."DocumentTemplateVersion" WHERE "id" = i."templateVersionId";
    SELECT * INTO t FROM public."DocumentTemplate" WHERE "id" = i."templateId";
    IF v."id" IS NULL OR t."id" IS NULL THEN
      problem := 'its template is gone';
    ELSIF encode(sha256(convert_to(v."bodyHtml", 'UTF8')), 'hex') <> i."templateContentSha256" THEN
      problem := 'the wording of template version ' || v."version" || ' changed after the ' || replace(lower(p_kind::text), '_', ' ') || ' was issued';
    ELSIF t."kind" <> 'CUSTOM' OR t."deletedAt" IS NOT NULL OR NOT t."isActive" THEN
      problem := 'its template is not in use';
    ELSIF t."requiresApproval" AND (v."approvedById" IS NULL OR v."approvedAt" IS NULL) THEN
      problem := 'template version ' || v."version" || ' was never approved';
    ELSIF p_require_current AND (v."status" <> 'ACTIVE' OR t."currentVersionId" IS DISTINCT FROM v."id") THEN
      problem := 'template version ' || v."version" || ' is no longer the current approved version; issue the ' || replace(lower(p_kind::text), '_', ' ') || ' again';
    ELSIF NOT p_require_current AND v."status" = 'DRAFT' THEN
      problem := 'template version ' || v."version" || ' is not an approved version';
    END IF;
  END IF;
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  RETURN problem;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The gate.
-- ---------------------------------------------------------------------------
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
  kfs record;
  agreement record;
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
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A loan without a key facts statement and a loan agreement from an approved template cannot be ' || CASE WHEN signing THEN 'signed' ELSE 'disbursed' END || ': ' || problem;
  END IF;

  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
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
  IF agreement."clientDocumentId" IS DISTINCT FROM NEW."agreementDocumentId" OR agreement."pdfSha256" IS DISTINCT FROM NEW."agreementDocumentSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The agreement being signed is not the issued loan agreement';
  END IF;
  IF kfs."termsSha256" <> public."loanApplicationTermsSha256"(NEW."id") OR agreement."termsSha256" <> kfs."termsSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The approved terms changed after the documents were issued; issue them again';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- LoanDocumentIssuance: immutable but for supersession and the one acknowledgement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."guardLoanDocumentIssuance"()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  previous_bypass text;
  app record;
  v record;
  t record;
  doc record;
  demo boolean;
  signed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An issued loan document cannot be deleted; supersede it';
  END IF;

  previous_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT "status"::text AS status, "disclosureRegime"::text AS regime, "clientId", "agreementSignedAt" INTO app
    FROM public."LoanApplication" WHERE "id" = NEW."applicationId";
  PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
  signed := app."agreementSignedAt" IS NOT NULL;

  IF TG_OP = 'INSERT' THEN
    IF app.regime <> 'KEY_FACTS' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a key-facts application has issued loan documents';
    END IF;
    IF app.status <> 'APPROVED' OR signed THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Loan documents are issued for an approved, unsigned application';
    END IF;
    PERFORM set_config('app.rls_bypass', 'on', true);
    SELECT * INTO v FROM public."DocumentTemplateVersion" WHERE "id" = NEW."templateVersionId";
    SELECT * INTO t FROM public."DocumentTemplate" WHERE "id" = NEW."templateId";
    SELECT "clientId", "contentSha256", "generatedFromVersionId", "deletedAt" INTO doc FROM public."ClientDocument" WHERE "id" = NEW."clientDocumentId";
    SELECT coalesce("isDemoLender", false) INTO demo FROM public."TenantConfig" WHERE "tenantId" = NEW."tenantId";
    PERFORM set_config('app.rls_bypass', coalesce(previous_bypass, ''), true);
    IF v."templateId" IS DISTINCT FROM NEW."templateId" OR v."version" IS DISTINCT FROM NEW."templateVersionNumber" OR t."key" IS DISTINCT FROM NEW."templateKey" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The issuance does not match its template version';
    END IF;
    IF t."kind" <> 'CUSTOM' OR t."deletedAt" IS NOT NULL OR NOT t."isActive" OR t."currentVersionId" IS DISTINCT FROM v."id" OR v."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan document is issued from the current approved version of its template';
    END IF;
    IF t."requiresApproval" AND (v."approvedById" IS NULL OR v."approvedAt" IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A loan document is issued from an approved template version';
    END IF;
    IF encode(sha256(convert_to(v."bodyHtml", 'UTF8')), 'hex') <> NEW."templateContentSha256" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The issuance does not carry the wording of its template version';
    END IF;
    IF doc."clientId" IS DISTINCT FROM app."clientId" OR doc."deletedAt" IS NOT NULL OR doc."contentSha256" IS DISTINCT FROM NEW."pdfSha256"
       OR doc."generatedFromVersionId" IS DISTINCT FROM NEW."templateVersionId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The issuance does not match the document rendered from that template version for this borrower';
    END IF;
    IF NEW."termsSha256" IS DISTINCT FROM public."loanApplicationTermsSha256"(NEW."applicationId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The issuance does not carry the application''s approved terms';
    END IF;
    IF NEW."supersededAt" IS NOT NULL OR NEW."acknowledgedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A new issuance is standing and unacknowledged';
    END IF;
    NEW."sample" := coalesce(demo, false);
    RETURN NEW;
  END IF;

  -- UPDATE: everything is fixed but supersession and the one acknowledgement.
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."templateId" IS DISTINCT FROM OLD."templateId" OR NEW."templateKey" IS DISTINCT FROM OLD."templateKey"
     OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId" OR NEW."templateVersionNumber" IS DISTINCT FROM OLD."templateVersionNumber"
     OR NEW."templateContentSha256" IS DISTINCT FROM OLD."templateContentSha256" OR NEW."clientDocumentId" IS DISTINCT FROM OLD."clientDocumentId"
     OR NEW."pdfSha256" IS DISTINCT FROM OLD."pdfSha256" OR NEW."termsSha256" IS DISTINCT FROM OLD."termsSha256" OR NEW."sample" IS DISTINCT FROM OLD."sample"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" OR NEW."issuedById" IS DISTINCT FROM OLD."issuedById" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An issued loan document is immutable';
  END IF;
  IF NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" THEN
    IF OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An issued loan document is superseded once';
    END IF;
    IF signed THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The documents of a signed application cannot be superseded';
    END IF;
  END IF;
  IF NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt" OR NEW."acknowledgedById" IS DISTINCT FROM OLD."acknowledgedById"
     OR NEW."acknowledgedSha256" IS DISTINCT FROM OLD."acknowledgedSha256" THEN
    IF OLD."acknowledgedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A key facts statement is acknowledged once';
    END IF;
    IF OLD."supersededAt" IS NOT NULL OR signed OR app.status <> 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a standing key facts statement of an approved, unsigned application can be acknowledged';
    END IF;
    IF NEW."acknowledgedById" IS DISTINCT FROM app."clientId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A key facts statement is acknowledged by the borrower';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;


CREATE TRIGGER "LoanApplication_a00_set_disclosure_regime" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION public."setLoanApplicationDisclosureRegime"();
CREATE TRIGGER "LoanApplication_guard_disclosure_regime" BEFORE UPDATE OF "disclosureRegime" ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION public."guardLoanApplicationDisclosureRegime"();
CREATE TRIGGER "LoanApplication_z_guard_key_facts_documents" BEFORE UPDATE OF "status", "agreementSignedAt" ON "LoanApplication" FOR EACH ROW WHEN (NEW."disclosureRegime" = 'KEY_FACTS') EXECUTE FUNCTION public."guardLoanApplicationKeyFactsDocuments"();
CREATE TRIGGER "LoanDocumentIssuance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LoanDocumentIssuance" FOR EACH ROW EXECUTE FUNCTION public."guardLoanDocumentIssuance"();
