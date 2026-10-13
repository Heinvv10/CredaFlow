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
ADD COLUMN     "ncaRegimeChangedAt" TIMESTAMP(3),
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
    "status" "NcaOverrideStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
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
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_decision_complete" CHECK (("status" = 'PENDING') = ("decidedById" IS NULL AND "decidedAt" IS NULL));
-- The approver of an override that relaxes the regime (NCA → NON_NCA) is
-- never its requester. Moving to NCA only adds protection; one person may.
ALTER TABLE "NcaRegimeOverride" ADD CONSTRAINT "NcaRegimeOverride_four_eyes" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById" OR "toRegime" = 'NCA');

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

-- An application's regime: set once by classification (from NULL, before a
-- decision); changed afterwards only to NCA (stricter), or to NON_NCA through
-- an APPROVED NcaRegimeOverride for exactly that change; frozen once the
-- application is decided. A row inserted already decided cannot be NON_NCA.
CREATE OR REPLACE FUNCTION "guardLoanApplicationNcaRegime"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."ncaRegime" = 'NON_NCA' AND NEW."status"::TEXT NOT IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A NON_NCA application must be classified before it is decided';
    END IF;
    -- Only this trigger writes the change timestamp.
    NEW."ncaRegimeChangedAt" := CASE WHEN NEW."ncaRegime" IS NULL THEN NULL ELSE clock_timestamp() END;
    RETURN NEW;
  END IF;

  IF NEW."ncaRegime" IS NOT DISTINCT FROM OLD."ncaRegime" THEN
    IF NEW."ncaRegimeChangedAt" IS DISTINCT FROM OLD."ncaRegimeChangedAt" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'ncaRegimeChangedAt is maintained by the database';
    END IF;
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

  -- Only the most recent APPROVED override counts: an old approval does not
  -- authorise a later flip after the regime went back to NCA.
  IF OLD."ncaRegime" = 'NCA' AND NEW."ncaRegime" = 'NON_NCA' AND NOT EXISTS (
    SELECT 1
    FROM (
      SELECT override."fromRegime", override."toRegime", override."decidedAt"
      FROM "NcaRegimeOverride" AS override
      WHERE override."applicationId" = NEW."id"
        AND override."tenantId" = NEW."tenantId"
        AND override."status" = 'APPROVED'
      ORDER BY override."decidedAt" DESC, override."id" DESC
      LIMIT 1
    ) AS latest
    WHERE latest."fromRegime" = 'NCA' AND latest."toRegime" = 'NON_NCA'
      AND (OLD."ncaRegimeChangedAt" IS NULL OR latest."decidedAt" > OLD."ncaRegimeChangedAt")
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'NCA to NON_NCA requires an approved NcaRegimeOverride';
  END IF;

  NEW."ncaRegimeChangedAt" := clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_guard_nca_regime_insert" BEFORE INSERT ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationNcaRegime"();
CREATE TRIGGER "LoanApplication_guard_nca_regime_update" BEFORE UPDATE OF "ncaRegime", "ncaRegimeChangedAt" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationNcaRegime"();

-- A loan's borrower and regime are its application's, fixed at booking: a
-- consumer loan cannot later be relabelled NON_NCA to escape s129 or the caps.
CREATE OR REPLACE FUNCTION "guardLoanBorrowerRegime"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ncaRegime" IS DISTINCT FROM OLD."ncaRegime"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
      OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A loan''s borrower and NCA regime are fixed at booking';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
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

  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Loan_guard_borrower_regime_insert" BEFORE INSERT ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION "guardLoanBorrowerRegime"();
CREATE TRIGGER "Loan_guard_borrower_regime_update" BEFORE UPDATE OF "ncaRegime", "clientId", "entityId", "applicationId" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION "guardLoanBorrowerRegime"();

-- At most one open override request per application.
CREATE UNIQUE INDEX "NcaRegimeOverride_one_pending_per_application" ON "NcaRegimeOverride" ("applicationId") WHERE "status" = 'PENDING';

-- An override belongs to its application's tenant.
CREATE OR REPLACE FUNCTION "guardNcaRegimeOverrideTenant"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "LoanApplication" AS application
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
  FOR EACH ROW EXECUTE FUNCTION "guardNcaRegimeOverrideTenant"();

-- assertDisbursedCreditLifeCoverage: NON_NCA deals keep the loan/disbursement
-- commit-together rule and skip the credit-life coverage checks.
CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCoverage"(target_application_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_status "AppStatus";
  application_disbursed_at TIMESTAMP(3);
  application_tenant_id TEXT;
  application_client_id TEXT;
  application_nca_regime "NcaRegime";
  loan_id TEXT;
  loan_tenant_id TEXT;
  loan_client_id TEXT;
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
    application."ncaRegime",
    loan."id",
    loan."tenantId",
    loan."clientId",
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    application_status,
    application_disbursed_at,
    application_tenant_id,
    application_client_id,
    application_nca_regime,
    loan_id,
    loan_tenant_id,
    loan_client_id,
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
