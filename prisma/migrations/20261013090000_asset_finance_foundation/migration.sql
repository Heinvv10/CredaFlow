-- CreateEnum
CREATE TYPE "NcaRegime" AS ENUM ('NCA', 'NON_NCA');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('LOAN', 'INSTALMENT_SALE', 'FINANCE_LEASE', 'OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE');

-- CreateEnum
CREATE TYPE "BusinessEntityType" AS ENUM ('COMPANY', 'CC', 'TRUST', 'PARTNERSHIP');

-- CreateEnum
CREATE TYPE "EntityRole" AS ENUM ('DIRECTOR', 'MEMBER', 'TRUSTEE', 'AUTHORISED_SIGNATORY', 'SURETY', 'BENEFICIAL_OWNER');

-- CreateEnum
CREATE TYPE "TrusteeKind" AS ENUM ('NATURAL', 'JURISTIC');

-- CreateEnum
CREATE TYPE "NcaOverrideStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "NcaOverrideSource" AS ENUM ('CLASSIFIER', 'MANUAL');

-- AlterEnum
ALTER TYPE "LoanChargeType" ADD VALUE 'COLLECTION_FEE';

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "assetId" TEXT,
ADD COLUMN     "balloonAmount" INTEGER,
ADD COLUMN     "contractType" "ContractType" NOT NULL DEFAULT 'LOAN',
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "ncaRegime" "NcaRegime" NOT NULL DEFAULT 'NCA',
ALTER COLUMN "clientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "ncaClassificationEvidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "ncaClassificationInputs" JSONB,
ADD COLUMN     "ncaClassificationRule" TEXT,
ADD COLUMN     "ncaClassifiedAt" TIMESTAMP(3),
ADD COLUMN     "ncaClassifiedById" TEXT,
ADD COLUMN     "ncaRegime" "NcaRegime",
ALTER COLUMN "clientId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "LoanProduct" ADD COLUMN     "nonNcaCollectionFeeCents" INTEGER,
ADD COLUMN     "nonNcaDefaultInterestMargin" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "featureAssetFinance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BusinessEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "BusinessEntityType" NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "registrationNumber" TEXT NOT NULL,
    "mastersReference" TEXT,
    "vatNumber" TEXT,
    "annualTurnover" INTEGER,
    "totalAssetValue" INTEGER,
    "financialYearEnd" DATE,
    "financialsEvidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityRelationship" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" "EntityRole" NOT NULL,
    "trusteeKind" "TrusteeKind",
    "ownershipPct" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcaRegimeOverride" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromRegime" "NcaRegime" NOT NULL,
    "toRegime" "NcaRegime" NOT NULL,
    "reason" TEXT NOT NULL,
    "source" "NcaOverrideSource" NOT NULL,
    "status" "NcaOverrideStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "approvedEntityId" TEXT,
    "approvedAppliedAmount" INTEGER,
    "approvedProductId" TEXT,
    "approvedClassificationRule" TEXT,
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NcaRegimeOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessEntity_tenantId_idx" ON "BusinessEntity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEntity_tenantId_id_key" ON "BusinessEntity"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEntity_tenantId_type_registrationNumber_key" ON "BusinessEntity"("tenantId", "type", "registrationNumber");

-- CreateIndex
CREATE INDEX "EntityRelationship_tenantId_clientId_idx" ON "EntityRelationship"("tenantId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityRelationship_entityId_clientId_role_key" ON "EntityRelationship"("entityId", "clientId", "role");

-- CreateIndex
CREATE INDEX "NcaRegimeOverride_tenantId_applicationId_idx" ON "NcaRegimeOverride"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "Loan_entityId_idx" ON "Loan"("entityId");

-- AddForeignKey
ALTER TABLE "BusinessEntity" ADD CONSTRAINT "BusinessEntity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written (asset finance foundation, docs/asset-finance/DESIGN.md D1, D5)
-- ---------------------------------------------------------------------------

-- A borrower is exactly one of a natural-person Client or a BusinessEntity.
-- Existing rows all carry a clientId, so these validate.
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_borrower_xor" CHECK (num_nonnulls("clientId", "entityId") = 1);
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_borrower_xor" CHECK (num_nonnulls("clientId", "entityId") = 1);

-- A natural person is always an NCA consumer. Only a juristic borrower can be
-- classified NON_NCA, so no consumer loan can shed an NCA rule by flipping
-- its regime.
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_non_nca_requires_entity" CHECK ("ncaRegime" = 'NCA' OR "entityId" IS NOT NULL);
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_non_nca_requires_entity" CHECK ("ncaRegime" IS DISTINCT FROM 'NON_NCA' OR "entityId" IS NOT NULL);

-- A trustee row says whether the trustee is a natural or juristic person (the
-- classifier counts them); no other role carries a trustee kind.
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_trustee_kind" CHECK (("role" = 'TRUSTEE') = ("trusteeKind" IS NOT NULL));
ALTER TABLE "EntityRelationship" ADD CONSTRAINT "EntityRelationship_ownership_pct_range" CHECK ("ownershipPct" IS NULL OR ("ownershipPct" >= 0 AND "ownershipPct" <= 100));

-- NON_NCA arrears terms are non-negative.
ALTER TABLE "LoanProduct" ADD CONSTRAINT "LoanProduct_non_nca_arrears_terms" CHECK (("nonNcaDefaultInterestMargin" IS NULL OR "nonNcaDefaultInterestMargin" >= 0) AND ("nonNcaCollectionFeeCents" IS NULL OR "nonNcaCollectionFeeCents" >= 0));

-- An override changes the regime, and its decision fields are all-or-nothing.
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_changes_regime" CHECK ("fromRegime" <> "toRegime");
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_decision_complete" CHECK (
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL)
  OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);
-- The approver of an override that relaxes the regime (NCA → NON_NCA) is
-- never its requester. Both ids are real users of the override's tenant
-- (composite FKs NcaRegimeOverride_tenantId_requestedById_fkey and
-- _decidedById_fkey), so they compare exactly: a padded or invented id names
-- no user and fails the FK. Moving to NCA only adds protection, and a
-- rejection grants nothing (the classifier rejects its own superseded
-- requests); one person may do either.
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_four_eyes" CHECK ("status" <> 'APPROVED' OR "toRegime" = 'NCA' OR ("decidedById" IS NOT NULL AND "decidedById" IS DISTINCT FROM "requestedById"));
-- The application an override was requested on (borrower, amount, product,
-- classification rule) is recorded whole, and always for a move to NON_NCA:
-- that is what the approver agreed to (guardLoanApplicationNcaRegime).
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_non_nca_snapshot" CHECK (
  num_nonnulls("approvedEntityId", "approvedAppliedAmount", "approvedProductId", "approvedClassificationRule") IN (0, 4)
  AND ("toRegime" <> 'NON_NCA' OR "approvedEntityId" IS NOT NULL)
);
-- Only an approval to NON_NCA is spent (guardLoanApplicationNcaRegime stamps it).
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_applied_requires_approval" CHECK ("appliedAt" IS NULL OR ("status" = 'APPROVED' AND "toRegime" = 'NON_NCA'));

-- Entity borrowers (clientId NULL) pass the client-tenant check; the
-- composite entity FK binds their tenant instead. Otherwise unchanged.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationTenantBinding"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- An entity borrower's tenant is bound by the composite FK
  -- LoanApplication_tenantId_entityId_fkey; only a client needs this lookup.
  IF NEW."clientId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "Client" AS client
    WHERE client."id" = NEW."clientId"
      AND client."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application client must belong to the application tenant';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "LoanProduct" AS product
    WHERE product."id" = NEW."productId"
      AND product."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application product must belong to the application tenant';
  END IF;

  IF
    NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND NEW."pasqDocumentId" IS NOT NULL
    AND NOT EXISTS (
    SELECT 1
    FROM "ClientDocument" AS document
    WHERE document."id" = NEW."pasqDocumentId"
      AND document."tenantId" = NEW."tenantId"
      AND document."clientId" = NEW."clientId"
      AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
      AND document."deletedAt" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application PASQ must belong to the application tenant and client';
  END IF;

  RETURN NEW;
END;
$function$;

-- guardLoanApplicationCreditLifeOffer: NCA consumer rule; a NON_NCA (juristic) application is exempt.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationCreditLifeOffer"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_product_id TEXT;
  entering_approved_state BOOLEAN;
BEGIN
  -- Credit life (Reg. 2017) attaches to NCA credit agreements only.
  IF NEW."ncaRegime" = 'NON_NCA' THEN
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
    IF EXISTS (
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

-- lockLoanApplicationPasqDocument: NCA consumer rule; a NON_NCA (juristic) application is exempt.
CREATE OR REPLACE FUNCTION public."lockLoanApplicationPasqDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_document_id TEXT;
BEGIN
  -- The PASQ (NCA s92, Form 20) is an NCA consumer document.
  IF NEW."ncaRegime" = 'NON_NCA' THEN
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

-- guardLoanApplicationPasqApproval: NCA consumer rule; a NON_NCA (juristic) application is exempt.
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
  IF NEW."ncaRegime" = 'NON_NCA' THEN
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

-- guardLoanApplicationProviderCountersign: NCA consumer rule; a NON_NCA (juristic) application is exempt.
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
  IF NEW."ncaRegime" = 'NON_NCA' THEN
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

-- LoanApplication_approved_status_requires_pasq: unchanged for NCA; a NON_NCA (juristic) deal has no PASQ, and APPROVED/DISBURSED still needs an approver
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_approved_status_requires_pasq";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_status_requires_pasq" CHECK ((((((status)::text <> ALL (ARRAY['APPROVED'::text, 'DISBURSED'::text])) OR (((status)::text = 'APPROVED'::text) AND ("agreementSignedAt" IS NULL) AND ("agreementCountersignedAt" IS NULL) AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ((("pasqVersion" IS NULL) AND ("pasqGeneratedAt" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqDocumentSha256" IS NULL) AND ("pasqEvidence" IS NULL) AND ("pasqEvidenceSha256" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt") AND ((("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256")))))) OR (("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND ("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt"))) IS TRUE)) OR ("ncaRegime" = 'NON_NCA' AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL AND length(btrim("approvedById")) > 0 AND "pasqVersion" IS NULL AND "pasqDocumentId" IS NULL AND "pasqAcknowledgedAt" IS NULL AND "approvedPasqDocumentSha256" IS NULL) IS TRUE) NOT VALID;

-- ---------------------------------------------------------------------------
-- Regime integrity. NON_NCA switches off consumer rules (PASQ, credit life,
-- countersign, s129, NCA caps, consumer bureau), so the regime itself must not
-- be writable at will.
-- ---------------------------------------------------------------------------

-- A classification is recorded whole: regime, rule, when and by whom.
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_nca_classification_complete" CHECK (
  ("ncaRegime" IS NULL AND "ncaClassificationRule" IS NULL AND "ncaClassifiedAt" IS NULL AND "ncaClassifiedById" IS NULL)
  OR ("ncaRegime" IS NOT NULL AND "ncaClassificationRule" IS NOT NULL AND length(btrim("ncaClassificationRule")) > 0
      AND "ncaClassifiedAt" IS NOT NULL AND "ncaClassifiedById" IS NOT NULL AND length(btrim("ncaClassifiedById")) > 0)
);

-- A classification rule is one of the classifier's rule ids (NCA_RULE_IDS in
-- lib/asset-finance/nca-classifier.ts; lib/asset-finance/nca-rule-ids.test.ts
-- holds both lists equal). The triggers key on the exact text
-- ('LARGE_AGREEMENT' carries the R250 000 floor), so a padded, re-cased or
-- invented rule is refused rather than read as no rule at all.
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_nca_classification_rule_known" CHECK (
  "ncaClassificationRule" IS NULL OR "ncaClassificationRule" IN ('TRUST_FEW_NATURAL_TRUSTEES', 'TRUST_UNEVIDENCED',
    'FINANCIALS_UNPROVEN', 'JURISTIC_OVER_THRESHOLD', 'LARGE_AGREEMENT', 'JURISTIC_SMALL_AGREEMENT')
);
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_approved_classification_rule_known" CHECK (
  "approvedClassificationRule" IS NULL OR "approvedClassificationRule" IN ('TRUST_FEW_NATURAL_TRUSTEES', 'TRUST_UNEVIDENCED',
    'FINANCIALS_UNPROVEN', 'JURISTIC_OVER_THRESHOLD', 'LARGE_AGREEMENT', 'JURISTIC_SMALL_AGREEMENT')
);

-- An application's regime, and the facts it was decided on:
--  - Regime. NULL until classified, never removed. A row is never INSERTed
--    NON_NCA: it is inserted unclassified or NCA and then overridden. Every
--    change TO NON_NCA spends one APPROVED NcaRegimeOverride to NON_NCA that
--    has not been applied yet and whose snapshot (borrower, amount, product,
--    classification rule) is the application as it now stands: this trigger
--    stamps its appliedAt, so each approval authorises exactly one change, of
--    exactly the application the approver saw, and cannot be replayed after
--    the regime went back to NCA. A change to NCA (stricter) is free. Regime
--    changes only while the application is open; frozen once it is decided.
--  - Borrower. Once classified, clientId / entityId never change: the
--    classification was of that borrower. Once decided (or in the write that
--    decides it), no application's borrower changes, consumer included: the
--    decision was of that borrower, and a decided entity application that
--    became a consumer one would escape guardEntityApplicationStatus.
--  - Amount and product. While NON_NCA they never change (the classifier read
--    the principal debt); re-classify via NCA first.
--  - Snapshot. While NON_NCA, and once decided, the ncaClassification*
--    columns never change: a new classification goes back to NCA first,
--    which leaves the spent approval behind. While an approved NON_NCA
--    override is unspent they never change either: the approval is spent on
--    the justification its approver saw, not one swapped in after.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationNcaRegime"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  spent_override_id TEXT;
  snapshot_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."ncaRegime" = 'NON_NCA' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An application cannot be inserted NON_NCA: insert it unclassified or NCA, then override';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    OLD."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
    OR NEW."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
  ) AND (
    NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A decided application''s borrower cannot change';
  END IF;

  IF (OLD."ncaRegime" IS NOT NULL OR NEW."ncaRegime" IS NOT NULL) AND (
    NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A classified application''s borrower cannot change';
  END IF;

  IF (OLD."ncaRegime" = 'NON_NCA' OR NEW."ncaRegime" = 'NON_NCA') AND (
    NEW."appliedAmount" IS DISTINCT FROM OLD."appliedAmount"
    OR NEW."productId" IS DISTINCT FROM OLD."productId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A NON_NCA application''s amount and product cannot change; re-classify it NCA first';
  END IF;

  snapshot_changed :=
    NEW."ncaClassificationRule" IS DISTINCT FROM OLD."ncaClassificationRule"
    OR NEW."ncaClassificationInputs" IS DISTINCT FROM OLD."ncaClassificationInputs"
    OR NEW."ncaClassificationEvidenceIds" IS DISTINCT FROM OLD."ncaClassificationEvidenceIds"
    OR NEW."ncaClassifiedAt" IS DISTINCT FROM OLD."ncaClassifiedAt"
    OR NEW."ncaClassifiedById" IS DISTINCT FROM OLD."ncaClassifiedById";

  IF snapshot_changed AND (
    OLD."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
    OR OLD."ncaRegime" = 'NON_NCA'
    OR NEW."ncaRegime" = 'NON_NCA'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An application''s NCA classification snapshot is frozen while it is NON_NCA and once it is decided; re-classify it NCA first';
  END IF;

  -- The approver agreed to the classification as it stood. An approval to
  -- NON_NCA writes this row (guardNcaRegimeOverrideLifecycle), so a write here
  -- either sees it committed or fails to serialize against it.
  IF snapshot_changed AND EXISTS (
    SELECT 1
    FROM public."NcaRegimeOverride" AS approval
    WHERE approval."applicationId" = OLD."id"
      AND approval."status" = 'APPROVED'
      AND approval."toRegime" = 'NON_NCA'
      AND approval."appliedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An application''s NCA classification snapshot is frozen while an approved NON_NCA override awaits it';
  END IF;

  IF NEW."ncaRegime" IS NOT DISTINCT FROM OLD."ncaRegime" THEN
    RETURN NEW;
  END IF;

  IF OLD."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An application''s NCA regime is frozen once it is decided';
  END IF;

  IF NEW."ncaRegime" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA classification cannot be removed';
  END IF;

  IF NEW."ncaRegime" = 'NON_NCA' THEN
    UPDATE public."NcaRegimeOverride" AS override
    SET "appliedAt" = clock_timestamp()
    WHERE override."id" = (
      SELECT candidate."id"
      FROM public."NcaRegimeOverride" AS candidate
      WHERE candidate."applicationId" = NEW."id"
        AND candidate."tenantId" = NEW."tenantId"
        AND candidate."status" = 'APPROVED'
        AND candidate."toRegime" = 'NON_NCA'
        AND candidate."appliedAt" IS NULL
        AND candidate."approvedEntityId" = NEW."entityId"
        AND candidate."approvedAppliedAmount" = NEW."appliedAmount"
        AND candidate."approvedProductId" = NEW."productId"
        AND candidate."approvedClassificationRule" = NEW."ncaClassificationRule"
      ORDER BY candidate."decidedAt", candidate."id"
      LIMIT 1
      FOR UPDATE
    )
    RETURNING override."id" INTO spent_override_id;

    IF spent_override_id IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public."NcaRegimeOverride" AS candidate
        WHERE candidate."applicationId" = NEW."id"
          AND candidate."tenantId" = NEW."tenantId"
          AND candidate."status" = 'APPROVED'
          AND candidate."toRegime" = 'NON_NCA'
          AND candidate."appliedAt" IS NULL
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'The NON_NCA approval no longer matches the application (borrower, amount, product or classification rule changed since it was requested)';
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A change to NON_NCA requires an approved NcaRegimeOverride that has not been applied';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_guard_nca_regime_insert" BEFORE INSERT ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanApplicationNcaRegime"();
CREATE TRIGGER "LoanApplication_guard_nca_regime_update" BEFORE UPDATE OF "ncaRegime", "clientId", "entityId",
  "appliedAmount", "productId", "ncaClassificationRule", "ncaClassificationInputs", "ncaClassificationEvidenceIds",
  "ncaClassifiedAt", "ncaClassifiedById" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanApplicationNcaRegime"();

-- An entity application's decision is final, so its frozen regime stays
-- frozen: once it leaves DRAFT / SUBMITTED / UNDER_REVIEW it never re-enters
-- them (directly, or through DECLINED / CANCELLED), and once DISBURSED its
-- status never changes, loan or no loan (with Loan_refuse_entity_delete, a
-- booked loan cannot be deleted and re-booked on other terms). An application
-- is an entity one when the row before or after the write names an entity; a
-- decided application's borrower never changes (guardLoanApplicationNcaRegime).
-- A consumer application is untouched: its APPROVED → UNDER_REVIEW
-- return-to-review is guarded by the PASQ triggers, and it is always NCA.
CREATE OR REPLACE FUNCTION public."guardEntityApplicationStatus"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (OLD."entityId" IS NULL AND NEW."entityId" IS NULL)
    OR NEW."status" IS NOT DISTINCT FROM OLD."status"
  THEN
    RETURN NEW;
  END IF;

  IF OLD."status"::TEXT = 'DISBURSED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A disbursed entity application cannot change status';
  END IF;

  IF OLD."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
    AND NEW."status"::TEXT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A decided entity application cannot be reopened';
  END IF;

  -- Only these moves exist for an entity application; DECLINED and CANCELLED
  -- are final, and DISBURSED follows APPROVED only.
  IF NOT (
    (OLD."status"::TEXT = 'DRAFT' AND NEW."status"::TEXT IN ('SUBMITTED', 'DECLINED', 'CANCELLED'))
    OR (OLD."status"::TEXT = 'SUBMITTED' AND NEW."status"::TEXT IN ('UNDER_REVIEW', 'APPROVED', 'DECLINED', 'CANCELLED'))
    OR (OLD."status"::TEXT = 'UNDER_REVIEW' AND NEW."status"::TEXT IN ('APPROVED', 'DECLINED', 'CANCELLED'))
    OR (OLD."status"::TEXT = 'APPROVED' AND NEW."status"::TEXT IN ('DISBURSED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('An entity application cannot move from %s to %s', OLD."status", NEW."status");
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_guard_entity_status" BEFORE UPDATE OF "status" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardEntityApplicationStatus"();

-- A loan's borrower and regime are its application's, fixed at booking: a
-- consumer loan cannot later be relabelled NON_NCA to escape s129 or the caps.
-- Its contract type is fixed at booking too (repricing eligibility keys on it).
-- A NON_NCA loan is booked only on a decided application (APPROVED or
-- DISBURSED), whose regime is frozen; and a NON_NCA classification that rests
-- on the large-agreement exclusion (s4(1)(b), s9(4)(b)) holds only for a
-- principal at or above the threshold. 25000000 cents is
-- NCA_LARGE_AGREEMENT_THRESHOLD_CENTS in lib/asset-finance/nca-thresholds.ts;
-- change both together.
CREATE OR REPLACE FUNCTION public."guardLoanBorrowerRegime"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  application_status TEXT;
  application_rule TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ncaRegime" IS DISTINCT FROM OLD."ncaRegime"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
      OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
      OR NEW."contractType" IS DISTINCT FROM OLD."contractType"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A loan''s borrower, NCA regime and contract type are fixed at booking';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public."LoanApplication" AS application
    WHERE application."id" = NEW."applicationId"
      AND application."tenantId" = NEW."tenantId"
      AND application."clientId" IS NOT DISTINCT FROM NEW."clientId"
      AND application."entityId" IS NOT DISTINCT FROM NEW."entityId"
      AND COALESCE(application."ncaRegime", 'NCA') = NEW."ncaRegime"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A loan must carry its application''s tenant, borrower and NCA regime';
  END IF;

  IF NEW."ncaRegime" = 'NON_NCA' THEN
    -- Held until commit, so the application cannot leave its decided state
    -- underneath the booking.
    SELECT application."status"::TEXT, application."ncaClassificationRule"
    INTO application_status, application_rule
    FROM public."LoanApplication" AS application
    WHERE application."id" = NEW."applicationId"
    FOR SHARE;

    IF application_status NOT IN ('APPROVED', 'DISBURSED') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A NON_NCA loan requires an approved application (its regime frozen)';
    END IF;

    IF application_rule = 'LARGE_AGREEMENT' AND NEW."principal" < 25000000 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A NON_NCA large agreement needs a principal of at least R250 000';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Loan_guard_borrower_regime_insert" BEFORE INSERT ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanBorrowerRegime"();
CREATE TRIGGER "Loan_guard_borrower_regime_update" BEFORE UPDATE OF "ncaRegime", "clientId", "entityId", "applicationId", "contractType" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanBorrowerRegime"();

-- An entity loan is never deleted: a loan deleted and booked again would
-- change what guardLoanBorrowerRegime fixes at booking (contract type,
-- regime). TRUNCATE is refused while any entity loan exists. Consumer loans
-- are unchanged.
CREATE OR REPLACE FUNCTION public."refuseEntityLoanDelete"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public."Loan" AS loan WHERE loan."entityId" IS NOT NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An entity loan is never deleted (TRUNCATE refused)';
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'An entity loan is never deleted';
END;
$function$;

CREATE TRIGGER "Loan_refuse_entity_delete" BEFORE DELETE ON "Loan"
  FOR EACH ROW WHEN (OLD."entityId" IS NOT NULL) EXECUTE FUNCTION public."refuseEntityLoanDelete"();
CREATE TRIGGER "Loan_refuse_entity_truncate" BEFORE TRUNCATE ON "Loan"
  FOR EACH STATEMENT EXECUTE FUNCTION public."refuseEntityLoanDelete"();

-- A collection fee is a NON_NCA contract charge (lib/asset-finance/non-nca-charges.ts);
-- an NCA loan's arrears charges are capped by the Act and never include one.
-- Loan.ncaRegime is fixed at booking, so checking the charge row suffices.
CREATE OR REPLACE FUNCTION public."guardLoanChargeCollectionFee"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."type"::TEXT = 'COLLECTION_FEE' AND NOT EXISTS (
    SELECT 1
    FROM public."Loan" AS loan
    WHERE loan."id" = NEW."loanId"
      AND loan."tenantId" = NEW."tenantId"
      AND loan."ncaRegime" = 'NON_NCA'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A collection fee may only be charged on a NON_NCA loan';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanCharge_guard_collection_fee" BEFORE INSERT OR UPDATE OF "type", "loanId", "tenantId" ON "LoanCharge"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanChargeCollectionFee"();

-- At most one open override request per application.
CREATE UNIQUE INDEX "NcaRegimeOverride_one_pending_per_application" ON "NcaRegimeOverride" ("applicationId") WHERE "status" = 'PENDING';

-- An override belongs to its application's tenant.
CREATE OR REPLACE FUNCTION public."guardNcaRegimeOverrideTenant"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."LoanApplication" AS application
    WHERE application."id" = NEW."applicationId" AND application."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA regime override must belong to its application''s tenant';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "NcaRegimeOverride_guard_tenant" BEFORE INSERT OR UPDATE OF "tenantId", "applicationId" ON "NcaRegimeOverride"
  FOR EACH ROW EXECUTE FUNCTION public."guardNcaRegimeOverrideTenant"();

-- An override is the record of who asked for a regime change and who agreed:
-- never deleted or truncated; requested only on a classified application, its
-- snapshot (when recorded; always for NON_NCA) being that application as it
-- stands; one to NON_NCA is inserted PENDING (a second person decides it; a
-- move to NCA may be decided as it is requested); the request (tenant,
-- application, from, to, reason, source, requester, snapshot, creation) never
-- changes; PENDING is decided once, to APPROVED or REJECTED; after that the
-- only write is appliedAt going from NULL to a value, when
-- guardLoanApplicationNcaRegime spends the approval.
CREATE OR REPLACE FUNCTION public."guardNcaRegimeOverrideLifecycle"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  application_regime "NcaRegime";
  application_entity_id TEXT;
  application_amount INTEGER;
  application_product_id TEXT;
  application_rule TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA regime override is never deleted (TRUNCATE refused)';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."toRegime" = 'NON_NCA' AND (NEW."status" <> 'PENDING' OR NEW."appliedAt" IS NOT NULL) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An override to NON_NCA is requested PENDING; a second person decides it';
    END IF;

    SELECT application."ncaRegime", application."entityId", application."appliedAmount",
      application."productId", application."ncaClassificationRule"
    INTO application_regime, application_entity_id, application_amount, application_product_id, application_rule
    FROM public."LoanApplication" AS application
    -- By id alone: NcaRegimeOverride_guard_tenant reports a tenant mismatch.
    WHERE application."id" = NEW."applicationId";

    IF application_regime IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An NCA regime override needs a classified application';
    END IF;

    IF NEW."approvedEntityId" IS NOT NULL AND (
      NEW."approvedEntityId" IS DISTINCT FROM application_entity_id
      OR NEW."approvedAppliedAmount" IS DISTINCT FROM application_amount
      OR NEW."approvedProductId" IS DISTINCT FROM application_product_id
      OR NEW."approvedClassificationRule" IS DISTINCT FROM application_rule
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An NCA regime override''s snapshot must be its application as it stands';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA regime override is never deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
    OR NEW."fromRegime" IS DISTINCT FROM OLD."fromRegime"
    OR NEW."toRegime" IS DISTINCT FROM OLD."toRegime"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
    OR NEW."approvedEntityId" IS DISTINCT FROM OLD."approvedEntityId"
    OR NEW."approvedAppliedAmount" IS DISTINCT FROM OLD."approvedAppliedAmount"
    OR NEW."approvedProductId" IS DISTINCT FROM OLD."approvedProductId"
    OR NEW."approvedClassificationRule" IS DISTINCT FROM OLD."approvedClassificationRule"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA regime override request is immutable';
  END IF;

  IF OLD."status" <> 'PENDING' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."decidedById" IS DISTINCT FROM OLD."decidedById"
    OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
    OR NEW."decisionNote" IS DISTINCT FROM OLD."decisionNote"
    OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt")
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An NCA regime override is immutable once decided';
  END IF;

  -- An approval to NON_NCA WRITES its application's row (a no-op touch of
  -- updatedAt), so the row carries the approval's transaction:
  --   - a READ COMMITTED snapshot write waits for the approval to commit, then
  --     sees it and is refused by guardLoanApplicationNcaRegime;
  --   - a REPEATABLE READ / SERIALIZABLE snapshot write whose snapshot predates
  --     the approval (or the request) fails to serialize on that row.
  IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' AND NEW."toRegime" = 'NON_NCA' THEN
    UPDATE public."LoanApplication" AS application
    SET "updatedAt" = clock_timestamp()
    WHERE application."id" = NEW."applicationId";
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "NcaRegimeOverride_guard_lifecycle" BEFORE INSERT OR UPDATE OR DELETE ON "NcaRegimeOverride"
  FOR EACH ROW EXECUTE FUNCTION public."guardNcaRegimeOverrideLifecycle"();
CREATE TRIGGER "NcaRegimeOverride_refuse_truncate" BEFORE TRUNCATE ON "NcaRegimeOverride"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardNcaRegimeOverrideLifecycle"();

-- assertDisbursedCreditLifeCoverage: NON_NCA deals keep the loan/disbursement
-- commit-together rule and skip the credit-life coverage checks. A loan's
-- regime must be its application's at commit, and a NON_NCA loan commits only
-- beside a DISBURSED NON_NCA application of the same tenant and entity, at a
-- principal its classification rule allows: guardLoanBorrowerRegime checks
-- these at booking, and this holds them against whatever else the
-- transaction writes before it commits (25000000 cents is
-- NCA_LARGE_AGREEMENT_THRESHOLD_CENTS, as there).
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
    OR loan_client_id IS NOT NULL
    OR application_client_id IS NOT NULL
    OR loan_entity_id IS NULL
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
