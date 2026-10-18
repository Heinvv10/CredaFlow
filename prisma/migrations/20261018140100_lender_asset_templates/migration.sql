-- CreateEnum
CREATE TYPE "DocumentTemplateApprovalBasis" AS ENUM ('SYNTHETIC_DEMO', 'LENDER_LEGAL');

-- AlterEnum

-- AlterTable
ALTER TABLE "DealSigner" ADD COLUMN     "issuanceId" TEXT;

-- AlterTable
ALTER TABLE "DocumentTemplate" ADD COLUMN     "assetFamily" TEXT,
ADD COLUMN     "assetVariant" TEXT;

-- AlterTable
ALTER TABLE "DocumentTemplateVersion" ADD COLUMN     "approvalBasis" "DocumentTemplateApprovalBasis",
ADD COLUMN     "approvedContentSha256" TEXT,
ADD COLUMN     "approvedSystemSha256" TEXT,
ADD COLUMN     "content" TEXT,
ADD COLUMN     "contentSha256" TEXT,
ADD COLUMN     "legalSignOffReference" TEXT;

-- CreateTable
CREATE TABLE "AssetDocumentIssuance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "document" "DealDocumentKind" NOT NULL,
    "clientId" TEXT,
    "templateKey" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "templateVersionNumber" INTEGER NOT NULL,
    "templateContentSha256" TEXT NOT NULL,
    "approvalBasis" "DocumentTemplateApprovalBasis" NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "legalSignOffReference" TEXT,
    "systemRevision" TEXT NOT NULL,
    "systemSha256" TEXT NOT NULL,
    "lenderIdentity" JSONB NOT NULL,
    "inputSha256" TEXT NOT NULL,
    "inputStoragePath" TEXT,
    "pdfSha256" TEXT NOT NULL,
    "pdfStoragePath" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedById" TEXT,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "AssetDocumentIssuance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetDocumentIssuance_tenantId_dealId_idx" ON "AssetDocumentIssuance"("tenantId", "dealId");

-- CreateIndex
CREATE INDEX "AssetDocumentIssuance_templateVersionId_idx" ON "AssetDocumentIssuance"("templateVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetDocumentIssuance_tenantId_id_key" ON "AssetDocumentIssuance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_tenantId_id_key" ON "DocumentTemplate"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "DealSigner" ADD CONSTRAINT "DealSigner_tenantId_issuanceId_fkey" FOREIGN KEY ("tenantId", "issuanceId") REFERENCES "AssetDocumentIssuance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetDocumentIssuance" ADD CONSTRAINT "AssetDocumentIssuance_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetDocumentIssuance" ADD CONSTRAINT "AssetDocumentIssuance_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "DocumentTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetDocumentIssuance" ADD CONSTRAINT "AssetDocumentIssuance_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written: lender-owned asset-finance templates
-- (docs/asset-finance/evidence/lender-owned-templates/SPEC.md). Everything
-- below is scoped to ASSET_FINANCE templates except the one-ACTIVE-version
-- index, which the publish route already maintains for every template.
-- ---------------------------------------------------------------------------

-- At most one ACTIVE version per template. The publish route has kept this
-- since its row lock; an older database that broke it stops here with the
-- template named, for an operator to resolve, rather than failing obscurely.
DO $$
DECLARE dup TEXT;
BEGIN
  SELECT "templateId" INTO dup FROM "DocumentTemplateVersion" WHERE "status" = 'ACTIVE' GROUP BY "templateId" HAVING count(*) > 1 LIMIT 1;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'DocumentTemplate % has more than one ACTIVE version; archive all but its currentVersionId before migrating', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX "DocumentTemplateVersion_one_active" ON "DocumentTemplateVersion"("templateId") WHERE "status" = 'ACTIVE';

ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_asset_finance_shape" CHECK (
  ("kind" = 'ASSET_FINANCE') = ("assetFamily" IS NOT NULL AND "assetVariant" IS NOT NULL)
  AND ("kind" <> 'ASSET_FINANCE' OR (
    "requiresApproval" = true
    AND "key" = "assetFamily" || '.' || "assetVariant"
    AND "signingMethod" = 'NONE'
    AND "assetFamily" || '.' || "assetVariant" IN (
      'af.isa.commercial', 'af.isa.cpa',
      'af.lease.operating.commercial', 'af.lease.operating.cpa',
      'af.lease.fml.commercial', 'af.lease.fml.cpa',
      'af.nca.instalment_sale', 'af.nca.finance_lease',
      'af.suretyship.nca', 'af.suretyship.commercial',
      'af.resolution.standard'
    )
  ))
);

ALTER TABLE "DocumentTemplateVersion" ADD CONSTRAINT "DocumentTemplateVersion_approval_shape" CHECK (
  ("approvedContentSha256" IS NULL OR ("approvedContentSha256" = "contentSha256" AND "approvedById" IS NOT NULL))
  AND ("approvalBasis" IS NULL OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedContentSha256" IS NOT NULL))
  AND ("approvalBasis" IS DISTINCT FROM 'LENDER_LEGAL' OR length(btrim(COALESCE("legalSignOffReference", ''))) >= 5)
  AND ("approvalBasis" IS DISTINCT FROM 'SYNTHETIC_DEMO' OR "legalSignOffReference" IS NULL)
  AND ("contentSha256" IS NULL OR "contentSha256" ~ '^[0-9a-f]{64}$')
  AND ("approvedSystemSha256" IS NULL OR ("approvedSystemSha256" ~ '^[0-9a-f]{64}$' AND "approvedById" IS NOT NULL))
);

-- The template a version belongs to (the store and issuance lock its row).
CREATE FUNCTION public."assetTemplateOfVersion"(version_template TEXT) RETURNS "DocumentTemplate"
LANGUAGE plpgsql AS $$
DECLARE t "DocumentTemplate";
BEGIN
  SELECT * INTO t FROM "DocumentTemplate" WHERE "id" = version_template;
  RETURN t;
END;
$$;

-- The approval basis a tenant's approvals must carry: a demo lender's are
-- synthetic, every other lender's are its legal sign-off.
CREATE FUNCTION public."assetTemplateBasisFor"(tenant TEXT) RETURNS "DocumentTemplateApprovalBasis"
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN COALESCE((SELECT c."isDemoLender" FROM "TenantConfig" c WHERE c."tenantId" = tenant), false)
    THEN 'SYNTHETIC_DEMO'::"DocumentTemplateApprovalBasis" ELSE 'LENDER_LEGAL'::"DocumentTemplateApprovalBasis" END
$$;

-- An active LOAN_ADMIN or above of the lender (the routes' guard, here too).
CREATE FUNCTION public."assetTemplateStaff"(tenant TEXT, user_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User" u WHERE u."id" = user_id AND u."tenantId" = tenant AND u."active" = true
      AND u."role" IN ('LOAN_ADMIN', 'BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN')
  )
$$;

CREATE FUNCTION public."guardAssetTemplateVersion"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t "DocumentTemplate";
BEGIN
  t := public."assetTemplateOfVersion"(CASE WHEN TG_OP = 'DELETE' THEN OLD."templateId" ELSE NEW."templateId" END);
  -- Not visible (another tenant's, under row-level security) or missing: fail closed.
  IF t."id" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A template version changes only with its template visible';
  END IF;
  IF t."kind" IS DISTINCT FROM 'ASSET_FINANCE' THEN
    IF TG_OP <> 'DELETE' AND (NEW."content" IS NOT NULL OR NEW."contentSha256" IS NOT NULL OR NEW."approvalBasis" IS NOT NULL OR NEW."approvedSystemSha256" IS NOT NULL
      OR NEW."approvedContentSha256" IS NOT NULL OR NEW."legalSignOffReference" IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only an asset-finance template version carries lender wording and an approval basis';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template version is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."content" IS NULL OR NEW."createdById" IS NULL
      OR NEW."approvedSystemSha256" IS NOT NULL
      OR NEW."approvedById" IS NOT NULL OR NEW."approvedAt" IS NOT NULL OR NEW."approvalBasis" IS NOT NULL
      OR NEW."approvedContentSha256" IS NOT NULL OR NEW."legalSignOffReference" IS NOT NULL
      OR NEW."activatedById" IS NOT NULL OR NEW."activatedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template version is created as an unapproved draft with its content and author';
    END IF;
    IF NOT public."assetTemplateStaff"(t."tenantId", NEW."createdById") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The author of an asset-finance template version is an active user of its lender';
    END IF;
    IF NEW."contentSha256" IS DISTINCT FROM encode(sha256(convert_to(NEW."content", 'UTF8')), 'hex') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contentSha256 is the SHA-256 of the version content';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
    OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."bodyHtml" IS DISTINCT FROM OLD."bodyHtml"
    OR NEW."tokensUsed"::text IS DISTINCT FROM OLD."tokensUsed"::text OR NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR NEW."notes" IS DISTINCT FROM OLD."notes" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template version is immutable: edit by creating a new draft';
  END IF;

  -- Approval: recorded once, on a draft, by someone other than its author.
  IF OLD."approvedById" IS NOT NULL THEN
    IF NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvalBasis" IS DISTINCT FROM OLD."approvalBasis" OR NEW."approvedContentSha256" IS DISTINCT FROM OLD."approvedContentSha256"
      OR NEW."legalSignOffReference" IS DISTINCT FROM OLD."legalSignOffReference"
      OR NEW."approvedSystemSha256" IS DISTINCT FROM OLD."approvedSystemSha256" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template approval is recorded once and never changed';
    END IF;
  ELSIF NEW."approvedById" IS NOT NULL THEN
    IF OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a draft asset-finance template version is approved, and approval does not publish it';
    END IF;
    IF NEW."approvedById" = OLD."createdById" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The author of an asset-finance template version cannot approve it';
    END IF;
    IF NOT public."assetTemplateStaff"(t."tenantId", NEW."approvedById") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The approver is an active user of the template''s lender';
    END IF;
    IF NEW."approvedAt" IS NULL OR NEW."approvedContentSha256" IS DISTINCT FROM OLD."contentSha256" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval binds the exact content hash of the version';
    END IF;
    IF NEW."approvedSystemSha256" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval binds the fingerprint of the protected wording it covers';
    END IF;
    IF NEW."approvalBasis" IS DISTINCT FROM public."assetTemplateBasisFor"(t."tenantId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A demo lender''s approval is SYNTHETIC_DEMO and every other lender''s is LENDER_LEGAL';
    END IF;
    IF NEW."approvalBasis" = 'LENDER_LEGAL' AND NOT EXISTS (
      SELECT 1 FROM "User" u WHERE u."id" = NEW."approvedById" AND u."tenantId" = t."tenantId" AND u."role" = 'SUPER_ADMIN'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A legal approval is recorded by a SUPER_ADMIN of the lender';
    END IF;
  ELSIF NEW."approvedAt" IS NOT NULL OR NEW."approvalBasis" IS NOT NULL OR NEW."approvedContentSha256" IS NOT NULL OR NEW."legalSignOffReference" IS NOT NULL OR NEW."approvedSystemSha256" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval names its approver';
  END IF;

  -- Status: DRAFT -> ACTIVE -> ARCHIVED, nothing else.
  IF OLD."activatedById" IS NOT NULL AND (NEW."activatedById" IS DISTINCT FROM OLD."activatedById" OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A publication is recorded once';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE' THEN
      IF NEW."approvedById" IS NULL OR OLD."approvedById" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template version is approved before it is published';
      END IF;
      IF NEW."activatedById" IS NULL OR NEW."activatedAt" IS NULL OR NEW."activatedById" = NEW."approvedById"
        OR NOT public."assetTemplateStaff"(t."tenantId", NEW."activatedById") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A different active user of the lender than its approver publishes the version';
      END IF;
      IF NEW."approvalBasis" IS DISTINCT FROM public."assetTemplateBasisFor"(t."tenantId") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The approval basis no longer matches the lender; approve a new draft';
      END IF;
    ELSIF NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template version moves DRAFT to ACTIVE to ARCHIVED only; copy an archived version into a new draft';
    END IF;
  ELSIF NEW."activatedById" IS DISTINCT FROM OLD."activatedById" OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A publication changes the status';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentTemplateVersion_asset_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentTemplateVersion"
FOR EACH ROW EXECUTE FUNCTION public."guardAssetTemplateVersion"();

CREATE FUNCTION public."guardAssetTemplate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'ASSET_FINANCE' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template is never deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD."kind" = 'ASSET_FINANCE' OR NEW."kind" = 'ASSET_FINANCE') AND (
    NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."key" IS DISTINCT FROM OLD."key"
    OR NEW."assetFamily" IS DISTINCT FROM OLD."assetFamily" OR NEW."assetVariant" IS DISTINCT FROM OLD."assetVariant"
    OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template''s lender, kind and document are fixed';
  END IF;
  IF NEW."kind" = 'ASSET_FINANCE' THEN
    IF TG_OP = 'INSERT' AND NEW."currentVersionId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template starts with no published version';
    END IF;
    IF NEW."currentVersionId" IS DISTINCT FROM (SELECT v."id" FROM "DocumentTemplateVersion" v WHERE v."templateId" = NEW."id" AND v."status" = 'ACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset-finance template points at its one ACTIVE version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DocumentTemplate_asset_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentTemplate"
FOR EACH ROW EXECUTE FUNCTION public."guardAssetTemplate"();

-- Issuance: only from the lender's current, approved version of the template
-- that matches the deal, with the approval copied exactly.
ALTER TABLE "AssetDocumentIssuance" ADD CONSTRAINT "AssetDocumentIssuance_shape" CHECK (
  "templateContentSha256" ~ '^[0-9a-f]{64}$' AND "inputSha256" ~ '^[0-9a-f]{64}$' AND "pdfSha256" ~ '^[0-9a-f]{64}$' AND "systemSha256" ~ '^[0-9a-f]{64}$'
  AND ("supersededAt" IS NOT NULL OR ("inputStoragePath" IS NOT NULL AND "pdfStoragePath" IS NOT NULL))
  AND (("document" = 'SURETYSHIP') = ("clientId" IS NOT NULL))
  AND CASE "document"
    WHEN 'AGREEMENT' THEN "templateKey" LIKE 'af.isa.%' OR "templateKey" LIKE 'af.lease.%' OR "templateKey" LIKE 'af.nca.%'
    WHEN 'SURETYSHIP' THEN "templateKey" LIKE 'af.suretyship.%'
    WHEN 'RESOLUTION' THEN "templateKey" = 'af.resolution.standard'
  END
  AND jsonb_typeof("lenderIdentity") = 'object'
);

CREATE FUNCTION public."assetTemplateKeyFits"(template_key TEXT, contract "ContractType", regime "NcaRegime", isa_cpa BOOLEAN, lease_cpa BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE template_key
    -- A finance lease outside the NCA is documented on the instalment sale agreement, as before lender templates.
    WHEN 'af.isa.commercial' THEN contract IN ('INSTALMENT_SALE', 'FINANCE_LEASE') AND regime IS DISTINCT FROM 'NCA' AND isa_cpa = false
    WHEN 'af.isa.cpa' THEN contract IN ('INSTALMENT_SALE', 'FINANCE_LEASE') AND regime IS DISTINCT FROM 'NCA' AND isa_cpa IS DISTINCT FROM false
    WHEN 'af.lease.operating.commercial' THEN contract = 'OPERATING_LEASE' AND lease_cpa = false
    WHEN 'af.lease.operating.cpa' THEN contract = 'OPERATING_LEASE' AND lease_cpa = true
    WHEN 'af.lease.fml.commercial' THEN contract = 'FULL_MAINTENANCE_LEASE' AND lease_cpa = false
    WHEN 'af.lease.fml.cpa' THEN contract = 'FULL_MAINTENANCE_LEASE' AND lease_cpa = true
    WHEN 'af.nca.instalment_sale' THEN contract = 'INSTALMENT_SALE' AND regime = 'NCA'
    WHEN 'af.nca.finance_lease' THEN contract = 'FINANCE_LEASE' AND regime = 'NCA'
    WHEN 'af.suretyship.nca' THEN regime IS DISTINCT FROM 'NON_NCA'
    WHEN 'af.suretyship.commercial' THEN regime = 'NON_NCA'
    WHEN 'af.resolution.standard' THEN true
    ELSE false
  END
$$;

CREATE FUNCTION public."guardAssetDocumentIssuance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  t "DocumentTemplate";
  v "DocumentTemplateVersion";
  d RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset document issuance is never deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL
      OR (to_jsonb(NEW) - 'supersededAt' - 'inputStoragePath' - 'pdfStoragePath') IS DISTINCT FROM (to_jsonb(OLD) - 'supersededAt' - 'inputStoragePath' - 'pdfStoragePath')
      OR (NEW."inputStoragePath" IS NOT NULL AND NEW."inputStoragePath" IS DISTINCT FROM OLD."inputStoragePath")
      OR (NEW."pdfStoragePath" IS NOT NULL AND NEW."pdfStoragePath" IS DISTINCT FROM OLD."pdfStoragePath") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset document issuance is immutable; an unsigned one is only marked superseded';
    END IF;
    IF EXISTS (SELECT 1 FROM "DealSigner" s WHERE s."tenantId" = OLD."tenantId" AND s."issuanceId" = OLD."id" AND (s."method" IS NOT NULL OR s."signedAt" IS NOT NULL)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A signed asset document issuance is never superseded';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO t FROM "DocumentTemplate" WHERE "id" = NEW."templateId" AND "tenantId" = NEW."tenantId" FOR SHARE;
  SELECT * INTO v FROM "DocumentTemplateVersion" WHERE "id" = NEW."templateVersionId";
  IF t."id" IS NULL OR t."kind" IS DISTINCT FROM 'ASSET_FINANCE' OR t."deletedAt" IS NOT NULL OR t."key" IS DISTINCT FROM NEW."templateKey"
    OR v."templateId" IS DISTINCT FROM t."id" OR t."currentVersionId" IS DISTINCT FROM v."id" OR v."status" IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document is issued only from its lender''s published version of that template';
  END IF;
  IF v."approvedById" IS NULL OR v."approvedContentSha256" IS DISTINCT FROM v."contentSha256"
    OR NEW."templateContentSha256" IS DISTINCT FROM v."contentSha256" OR NEW."templateVersionNumber" IS DISTINCT FROM v."version"
    OR NEW."approvalBasis" IS DISTINCT FROM v."approvalBasis" OR NEW."approvedById" IS DISTINCT FROM v."approvedById"
    OR NEW."approvedAt" IS DISTINCT FROM v."approvedAt" OR NEW."legalSignOffReference" IS DISTINCT FROM v."legalSignOffReference"
    OR NEW."systemSha256" IS DISTINCT FROM v."approvedSystemSha256" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An issuance carries the exact approved content and approval of its version';
  END IF;
  IF v."approvalBasis" IS DISTINCT FROM public."assetTemplateBasisFor"(NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The version''s approval basis no longer matches the lender';
  END IF;
  SELECT deal."contractType", deal."isaCpaApplies", deal."cpaApplies", app."ncaRegime" INTO d
  FROM "AssetFinanceDeal" deal JOIN "LoanApplication" app ON app."id" = deal."applicationId" AND app."tenantId" = deal."tenantId"
  WHERE deal."id" = NEW."dealId" AND deal."tenantId" = NEW."tenantId";
  IF NOT COALESCE(public."assetTemplateKeyFits"(NEW."templateKey", d."contractType", d."ncaRegime", d."isaCpaApplies", d."cpaApplies"), false) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The template does not fit the deal''s contract type, regime or CPA status';
  END IF;
  IF NEW."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An issuance is created current';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AssetDocumentIssuance_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssetDocumentIssuance"
FOR EACH ROW EXECUTE FUNCTION public."guardAssetDocumentIssuance"();

-- A deal signer created from now on binds a current issuance of the same
-- deal, document and bytes; an unsigned row without one (prepared before
-- lender templates) cannot be signed: prepare the documents again.
CREATE FUNCTION public."guardDealSignerIssuance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i "AssetDocumentIssuance";
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."issuanceId" IS NOT DISTINCT FROM OLD."issuanceId"
    AND NEW."documentSha256" IS NOT DISTINCT FROM OLD."documentSha256"
    AND NEW."documentStoragePath" IS NOT DISTINCT FROM OLD."documentStoragePath" THEN
    IF (OLD."method" IS NULL AND NEW."method" IS NOT NULL) OR (OLD."confirmedAt" IS NULL AND NEW."confirmedAt" IS NOT NULL) THEN
      IF NEW."issuanceId" IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A document prepared before lender templates is prepared again before it is signed';
      END IF;
      IF EXISTS (SELECT 1 FROM "AssetDocumentIssuance" iss WHERE iss."id" = NEW."issuanceId" AND iss."tenantId" = NEW."tenantId" AND iss."supersededAt" IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A superseded document is not signed';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."issuanceId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal signer binds the issuance of its document';
  END IF;
  SELECT * INTO i FROM "AssetDocumentIssuance" WHERE "id" = NEW."issuanceId" AND "tenantId" = NEW."tenantId";
  IF i."dealId" IS DISTINCT FROM NEW."dealId" OR i."document" IS DISTINCT FROM NEW."document" OR i."supersededAt" IS NOT NULL
    OR i."pdfSha256" IS DISTINCT FROM NEW."documentSha256" OR i."pdfStoragePath" IS DISTINCT FROM NEW."documentStoragePath"
    OR (NEW."document" = 'SURETYSHIP' AND i."clientId" IS DISTINCT FROM NEW."clientId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal signer binds a current issuance of its own deal, document and bytes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DealSigner_issuance" BEFORE INSERT OR UPDATE ON "DealSigner"
FOR EACH ROW EXECUTE FUNCTION public."guardDealSignerIssuance"();

ALTER TABLE "AssetDocumentIssuance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetDocumentIssuance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetDocumentIssuance" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- The audit row of an NCA asset quotation's issue records whether it printed
-- DRAFT (draftLegalWording), which decides whether a legally approved
-- agreement may follow it (lib/asset-finance/documents/templates/issuance.ts
-- ncaQuoteMarkProblem). That row is never changed or deleted.
CREATE FUNCTION public."guardNcaQuoteIssuedAudit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The record of an issued NCA quotation is never changed or deleted';
END;
$$;
CREATE TRIGGER "AuditLog_nca_quote_issued_immutable" BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW WHEN (OLD."action" = 'ASSET_NCA_QUOTE_ISSUED') EXECUTE FUNCTION public."guardNcaQuoteIssuedAudit"();
