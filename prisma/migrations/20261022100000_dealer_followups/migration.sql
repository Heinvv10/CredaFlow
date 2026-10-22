-- CreateEnum
CREATE TYPE "DealerConsentSigningMethod" AS ENUM ('IN_PERSON', 'REMOTE');

-- CreateEnum
CREATE TYPE "DealerDealPurgeReason" AS ENUM ('ABANDONED_DRAFT', 'CANCELLED_DRAFT', 'ENDED_AFTER_HANDOVER');

-- AlterTable
ALTER TABLE "DealerConsentAttestation" ADD COLUMN     "remoteIdentityCheck" TEXT,
ADD COLUMN     "signingMethod" "DealerConsentSigningMethod";

-- AlterTable
ALTER TABLE "BusinessEntity" ADD COLUMN     "dealerPurgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AssetFinanceDeal" ADD COLUMN     "cancelledByDealerUserId" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "dealerPurgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DealerDealPurge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "reason" "DealerDealPurgeReason" NOT NULL,
    "purgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientsErased" INTEGER NOT NULL,
    "clientsKept" INTEGER NOT NULL,
    "entitiesErased" INTEGER NOT NULL,
    "entitiesKept" INTEGER NOT NULL,
    "documentsErased" INTEGER NOT NULL,

    CONSTRAINT "DealerDealPurge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DealerDealPurge_tenantId_id_key" ON "DealerDealPurge"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DealerDealPurge_tenantId_dealId_key" ON "DealerDealPurge"("tenantId", "dealId");

-- AddForeignKey
ALTER TABLE "DealerDealPurge" ADD CONSTRAINT "DealerDealPurge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealerDealPurge" ADD CONSTRAINT "DealerDealPurge_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "AssetFinanceDeal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_cancelledByDealerUserId_fkey" FOREIGN KEY ("tenantId", "cancelledByDealerUserId") REFERENCES "DealerUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written (docs/asset-finance/SLICE5-FOLLOWUPS.md part D). Errors
-- RAISE ... USING ERRCODE = '23514'.
-- ---------------------------------------------------------------------------

ALTER TABLE "DealerDealPurge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealerDealPurge" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "DealerDealPurge" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- 1. Consent v2. A dealer-consent-v1 row (attested before this migration)
-- carries no signing method; every later version says how the form was
-- signed, and a remote signing what the dealer did to check identity.
ALTER TABLE "DealerConsentAttestation" ADD CONSTRAINT "DealerConsentAttestation_signing_method" CHECK (
  ("statementVersion" = 'dealer-consent-v1' AND "signingMethod" IS NULL AND "remoteIdentityCheck" IS NULL)
  OR ("statementVersion" <> 'dealer-consent-v1' AND "signingMethod" IS NOT NULL AND (
    ("signingMethod" = 'IN_PERSON' AND "remoteIdentityCheck" IS NULL)
    OR ("signingMethod" = 'REMOTE' AND "remoteIdentityCheck" IS NOT NULL AND char_length(btrim("remoteIdentityCheck")) BETWEEN 10 AND 500)))
);

-- The v1 statement asserted signature "in my presence"; no new attestation
-- may use it. Existing v1 rows keep their snapshot (guardDealerConsentAttestation
-- lets only the verification be added to any row).
CREATE OR REPLACE FUNCTION "guardDealerConsentCurrentVersion"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."statementVersion" = 'dealer-consent-v1' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A new dealer consent attestation uses the current statement, not dealer-consent-v1';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerConsentAttestation_current_version" BEFORE INSERT ON "DealerConsentAttestation"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerConsentCurrentVersion"();

-- 2. A dealer cancels its own draft. A CANCELLED deal names exactly one
-- canceller: a staff user or a dealer user.
ALTER TABLE "AssetFinanceDeal" DROP CONSTRAINT "AssetFinanceDeal_cancellation_shape";
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_cancellation_shape" CHECK (
  ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND num_nonnulls("cancelledById", "cancelledByDealerUserId") = 1
    AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 10)
  OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelledByDealerUserId" IS NULL
    AND "cancelReason" IS NULL)
);

-- The dealer's cancellation: only the move DRAFT → CANCELLED of a dealer deal
-- never handed to the lender, by an active user of the deal's dealer who is
-- its DEALER_ADMIN or the user who created the deal. Once handed over, the
-- deal is the lender's to cancel.
CREATE OR REPLACE FUNCTION "guardAssetDealDealerCancel"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."cancelledByDealerUserId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is created uncancelled';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."cancelledByDealerUserId" IS NOT DISTINCT FROM OLD."cancelledByDealerUserId" THEN
    RETURN NEW;
  END IF;
  IF OLD."cancelledByDealerUserId" IS NOT NULL OR OLD."dealerId" IS NULL OR OLD."status" <> 'DRAFT'
    OR OLD."dealerSubmittedAt" IS NOT NULL OR NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer cancels only its own draft, before handing it to the lender';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "DealerUser" u
    WHERE u."id" = NEW."cancelledByDealerUserId" AND u."tenantId" = NEW."tenantId" AND u."dealerId" = OLD."dealerId" AND u."active"
      AND (u."role" = 'DEALER_ADMIN' OR u."id" = OLD."dealerUserId")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer draft is cancelled by the user who created it or an admin of its dealer';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_dealer_cancel" BEFORE INSERT OR UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION "guardAssetDealDealerCancel"();

-- freezeTerminalAssetDeal (20261013114500) with the dealer canceller in the
-- cancel transition's whitelist; otherwise unchanged.
CREATE OR REPLACE FUNCTION public."freezeTerminalAssetDeal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" IN ('CANCELLED', 'DECLINED', 'REFUSED_NCA')
    AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A cancelled, declined or NCA-refused deal is terminal: it never changes';
  END IF;
  IF NEW."status" = 'CANCELLED' AND OLD."status" <> 'CANCELLED'
    AND (to_jsonb(NEW) - ARRAY['updatedAt', 'status', 'cancelledAt', 'cancelledById', 'cancelledByDealerUserId', 'cancelReason'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updatedAt', 'status', 'cancelledAt', 'cancelledById', 'cancelledByDealerUserId', 'cancelReason']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Cancelling a deal records who cancelled it, when and why, and changes nothing else';
  END IF;
  RETURN NEW;
END;
$function$;

-- 3. The dealer draft purge (POPIA s14). The one definition of which dealer
-- deal may be purged, and why: never a deal with a loan; a deal the lender
-- never received (dealerSubmittedAt NULL) 90 days after its last activity
-- (DRAFT) or its cancellation; a deal handed over that ended DECLINED,
-- REFUSED_NCA or CANCELLED three years after it ended (NCA Regulation 55:
-- the records of a declined application are kept three years).
CREATE OR REPLACE FUNCTION "dealerDealPurgeReason"(p_tenant TEXT, p_deal TEXT)
RETURNS "DealerDealPurgeReason"
LANGUAGE sql
STABLE
AS $function$
  SELECT (CASE
    WHEN d."status" = 'DRAFT' AND d."dealerSubmittedAt" IS NULL
      AND GREATEST(
        d."createdAt", d."updatedAt",
        (SELECT max(doc."createdAt") FROM "EntityDocument" doc WHERE doc."dealId" = d."id" AND doc."tenantId" = d."tenantId"),
        (SELECT max(a."attestedAt") FROM "DealerConsentAttestation" a WHERE a."dealId" = d."id" AND a."tenantId" = d."tenantId"),
        (SELECT max(GREATEST(r."requestedAt", r."fulfilledAt")) FROM "DealerDocumentRequest" r WHERE r."dealId" = d."id" AND r."tenantId" = d."tenantId"),
        (SELECT max(GREATEST(rel."createdAt", rel."updatedAt")) FROM "EntityRelationship" rel
          WHERE rel."entityId" = d."entityId" AND rel."tenantId" = d."tenantId")
      ) < (now() AT TIME ZONE 'UTC') - INTERVAL '90 days'
      THEN 'ABANDONED_DRAFT'
    WHEN d."status" = 'CANCELLED' AND d."dealerSubmittedAt" IS NULL
      AND d."cancelledAt" < (now() AT TIME ZONE 'UTC') - INTERVAL '90 days'
      THEN 'CANCELLED_DRAFT'
    WHEN d."status" IN ('DECLINED', 'REFUSED_NCA', 'CANCELLED') AND d."dealerSubmittedAt" IS NOT NULL
      AND COALESCE(d."cancelledAt", d."decidedAt", d."updatedAt") < (now() AT TIME ZONE 'UTC') - INTERVAL '3 years'
      THEN 'ENDED_AFTER_HANDOVER'
  END)::"DealerDealPurgeReason"
  FROM "AssetFinanceDeal" d
  WHERE d."id" = p_deal AND d."tenantId" = p_tenant AND d."dealerId" IS NOT NULL AND d."loanId" IS NULL
$function$;

-- Whether any row of any table with a foreign key to p_table refers to the
-- row p_id. Read from the catalog, so a table added later counts (fail closed).
CREATE OR REPLACE FUNCTION "dealerPurgeRowReferenced"(p_table TEXT, p_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  fk RECORD;
  hit BOOLEAN;
BEGIN
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child, parent)
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent AND pa.attname = 'id'
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child
    WHERE c.contype = 'f' AND c.confrelid = format('%I', p_table)::regclass
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', fk.tbl, fk.col) INTO hit USING p_id;
    IF hit THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$function$;

-- Whether the person (p_table 'Client') or business ('BusinessEntity') p_id
-- is linked to anything beyond the dealer deal p_deal: any row of any table
-- with a foreign key to it (read from the catalog, fail closed), except the
-- deal itself, its application, its documents, its consent attestations, the
-- person's ClientConsent, and the person's relationship to the deal's
-- business (only while that business is itself not linked elsewhere).
CREATE OR REPLACE FUNCTION "dealerPurgeLinkedElsewhere"(p_tenant TEXT, p_table TEXT, p_id TEXT, p_deal TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  deal RECORD;
  fk RECORD;
  extra TEXT;
  hit BOOLEAN;
  entity_free BOOLEAN := FALSE;
BEGIN
  IF p_table NOT IN ('Client', 'BusinessEntity') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'dealerPurgeLinkedElsewhere reads Client or BusinessEntity';
  END IF;
  SELECT d."applicationId", d."entityId" INTO deal FROM "AssetFinanceDeal" d WHERE d."id" = p_deal AND d."tenantId" = p_tenant;
  IF NOT FOUND THEN
    RETURN TRUE;
  END IF;
  IF p_table = 'Client' AND deal."entityId" IS NOT NULL THEN
    entity_free := NOT "dealerPurgeLinkedElsewhere"(p_tenant, 'BusinessEntity', deal."entityId", p_deal);
  END IF;
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, cl.relname AS relname, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child, parent)
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent AND pa.attname = 'id'
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child
    WHERE c.contype = 'f' AND c.confrelid = format('%I', p_table)::regclass
  LOOP
    CONTINUE WHEN fk.relname = 'ClientConsent' AND p_table = 'Client';
    CONTINUE WHEN fk.relname = 'EntityRelationship' AND p_table = 'BusinessEntity';
    extra := CASE
      WHEN fk.relname = 'AssetFinanceDeal' THEN format(' AND "id" <> %L', p_deal)
      WHEN fk.relname = 'LoanApplication' THEN format(' AND "id" <> %L', deal."applicationId")
      WHEN fk.relname IN ('EntityDocument', 'DealerConsentAttestation') THEN format(' AND "dealId" IS DISTINCT FROM %L', p_deal)
      WHEN fk.relname = 'EntityRelationship' AND entity_free THEN format(' AND "entityId" IS DISTINCT FROM %L', deal."entityId")
      ELSE ''
    END;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1%s)', fk.tbl, fk.col, extra) INTO hit USING p_id;
    IF hit THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$function$;

-- The tombstone: written only for a deal dealerDealPurgeReason names now,
-- with that reason; never changed or deleted.
CREATE OR REPLACE FUNCTION "guardDealerDealPurge"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal purge record is never changed or deleted';
  END IF;
  IF NEW."reason" IS DISTINCT FROM "dealerDealPurgeReason"(NEW."tenantId", NEW."dealId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This dealer deal may not be purged (or not for that reason)';
  END IF;
  IF least(NEW."clientsErased", NEW."clientsKept", NEW."entitiesErased", NEW."entitiesKept", NEW."documentsErased") < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal purge counts are not negative';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerDealPurge_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DealerDealPurge"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerDealPurge"();
CREATE TRIGGER "DealerDealPurge_no_truncate" BEFORE TRUNCATE ON "DealerDealPurge"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardDealerDealPurge"();

-- Erasing a dealer-captured person or business: setting dealerPurgedAt. The
-- database checks it may be erased (captured by a dealer; a purge record
-- exists for a deal naming it as borrower or as a person of its business;
-- linked to nothing else) and overwrites every identifying column itself.
-- Set once; never on INSERT. Named "a_" to run before the other BEFORE
-- triggers on the row, which then see the erased values.
CREATE OR REPLACE FUNCTION "guardDealerPurgedParty"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  erasable BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dealerPurgedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A new row is not purged';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."dealerPurgedAt" IS NOT DISTINCT FROM OLD."dealerPurgedAt" THEN
    RETURN NEW;
  END IF;
  IF OLD."dealerPurgedAt" IS NOT NULL OR NEW."dealerPurgedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purged dealer capture stays purged';
  END IF;
  IF OLD."createdByDealerId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a dealer-captured person or business is purged';
  END IF;
  IF TG_TABLE_NAME = 'Client' THEN
    SELECT EXISTS (
      SELECT 1 FROM "DealerDealPurge" p
      JOIN "AssetFinanceDeal" d ON d."id" = p."dealId" AND d."tenantId" = p."tenantId"
      WHERE p."tenantId" = NEW."tenantId" AND d."dealerId" = OLD."createdByDealerId"
        AND (d."clientId" = NEW."id" OR (d."entityId" IS NOT NULL AND EXISTS (
          SELECT 1 FROM "EntityRelationship" r WHERE r."tenantId" = d."tenantId" AND r."entityId" = d."entityId" AND r."clientId" = NEW."id")))
        AND NOT "dealerPurgeLinkedElsewhere"(NEW."tenantId", 'Client', NEW."id", d."id")
    ) INTO erasable;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM "DealerDealPurge" p
      JOIN "AssetFinanceDeal" d ON d."id" = p."dealId" AND d."tenantId" = p."tenantId"
      WHERE p."tenantId" = NEW."tenantId" AND d."dealerId" = OLD."createdByDealerId" AND d."entityId" = NEW."id"
        AND NOT "dealerPurgeLinkedElsewhere"(NEW."tenantId", 'BusinessEntity', NEW."id", d."id")
    ) INTO erasable;
  END IF;
  IF NOT erasable THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'This dealer capture is linked to more than a purged dealer deal: it is kept';
  END IF;
  IF TG_TABLE_NAME = 'Client' THEN
    NEW."idNumber" := 'erased-' || NEW."id";
    NEW."firstName" := 'Erased';
    NEW."lastName" := 'Erased';
    NEW."dateOfBirth" := NULL;
    NEW."gender" := NULL;
    NEW."email" := 'erased-' || NEW."id" || '@erased.invalid';
    NEW."phone" := '';
    NEW."whatsapp" := NULL;
    NEW."addressLine1" := NULL;
    NEW."suburb" := NULL;
    NEW."city" := NULL;
    NEW."province" := NULL;
    NEW."postalCode" := NULL;
    NEW."employmentStatus" := NULL;
    NEW."employerName" := NULL;
    NEW."employerAddress" := NULL;
    NEW."employmentStartDate" := NULL;
    NEW."monthlyIncome" := 0;
    NEW."monthlyExpenses" := 0;
    NEW."monthlyExpensesDeclaredAt" := NULL;
    NEW."grossMonthlyIncome" := NULL;
    NEW."incomeSourceType" := NULL;
    NEW."salaryPaymentDay" := NULL;
    NEW."bankName" := NULL;
    NEW."bankAccountNumber" := NULL;
    NEW."bankBranchCode" := NULL;
    NEW."accountType" := NULL;
    NEW."nextOfKinName" := NULL;
    NEW."nextOfKinPhone" := NULL;
    NEW."nextOfKinRelationship" := NULL;
    NEW."portalPassword" := NULL;
    NEW."preferredLanguage" := NULL;
    NEW."creditScore" := NULL;
  ELSE
    NEW."legalName" := 'Erased';
    NEW."tradingName" := NULL;
    NEW."registrationNumber" := 'erased-' || NEW."id";
    NEW."mastersReference" := NULL;
    NEW."vatNumber" := NULL;
    NEW."annualTurnover" := NULL;
    NEW."totalAssetValue" := NULL;
    NEW."financialYearEnd" := NULL;
    NEW."financialsEvidenceIds" := '{}';
    NEW."addressLine1" := NULL;
    NEW."addressLine2" := NULL;
    NEW."city" := NULL;
    NEW."province" := NULL;
    NEW."postalCode" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Client_a_dealer_purge" BEFORE INSERT OR UPDATE OF "dealerPurgedAt" ON "Client"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerPurgedParty"();
CREATE TRIGGER "BusinessEntity_a_dealer_purge" BEFORE INSERT OR UPDATE OF "dealerPurgedAt" ON "BusinessEntity"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerPurgedParty"();
