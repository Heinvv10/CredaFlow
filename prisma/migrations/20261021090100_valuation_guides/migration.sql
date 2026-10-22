-- CreateEnum
CREATE TYPE "ValuationGuideStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'DISCARDED');

-- AlterTable
ALTER TABLE "AssetValuation" ADD COLUMN     "guideId" TEXT,
ADD COLUMN     "guideRowId" TEXT,
ADD COLUMN     "guideSnapshot" JSONB;

-- CreateTable
CREATE TABLE "ValuationGuide" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "provider" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "fileSha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "status" "ValuationGuideStatus" NOT NULL DEFAULT 'DRAFT',
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "discardedById" TEXT,
    "discardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValuationGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValuationGuideRow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "tradeCents" INTEGER NOT NULL,
    "retailCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValuationGuideRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValuationGuide_tenantId_status_idx" ON "ValuationGuide"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ValuationGuide_tenantId_id_key" ON "ValuationGuide"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ValuationGuideRow_tenantId_guideId_idx" ON "ValuationGuideRow"("tenantId", "guideId");

-- CreateIndex
CREATE UNIQUE INDEX "ValuationGuideRow_tenantId_id_key" ON "ValuationGuideRow"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ValuationGuideRow_tenantId_guideId_id_key" ON "ValuationGuideRow"("tenantId", "guideId", "id");

-- AddForeignKey
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_tenantId_uploadedById_fkey" FOREIGN KEY ("tenantId", "uploadedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_tenantId_publishedById_fkey" FOREIGN KEY ("tenantId", "publishedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_tenantId_supersededById_fkey" FOREIGN KEY ("tenantId", "supersededById") REFERENCES "ValuationGuide"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_tenantId_discardedById_fkey" FOREIGN KEY ("tenantId", "discardedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ValuationGuideRow" ADD CONSTRAINT "ValuationGuideRow_tenantId_guideId_fkey" FOREIGN KEY ("tenantId", "guideId") REFERENCES "ValuationGuide"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_tenantId_guideId_fkey" FOREIGN KEY ("tenantId", "guideId") REFERENCES "ValuationGuide"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_tenantId_guideId_guideRowId_fkey" FOREIGN KEY ("tenantId", "guideId", "guideRowId") REFERENCES "ValuationGuideRow"("tenantId", "guideId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written: valuation guides (docs/asset-finance/SLICE5.md part C,
-- "CHECKs and indexes" and "Triggers"). Every refusal is SQLSTATE 23514;
-- every guard trigger has a _no_truncate statement trigger; "today" is the
-- Johannesburg calendar date. Tests: lib/valuation-guides/*.integration.test.ts
-- (RUN_ASSET_FINANCE_VALUATION_IT).
-- ---------------------------------------------------------------------------

-- Guides ------------------------------------------------------------------

ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_name" CHECK ("name" = btrim("name") AND length("name") BETWEEN 1 AND 100);
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_provider" CHECK ("provider" ~ '^[a-z0-9-]{1,40}$');
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_sha256" CHECK ("fileSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_row_count" CHECK ("rowCount" BETWEEN 1 AND 20000);
-- Who moved a guide, and when, are set exactly for the statuses it reached.
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_status_shape" CHECK (CASE "status"
  WHEN 'DRAFT' THEN num_nonnulls("publishedById", "publishedAt", "supersededById", "supersededAt", "discardedById", "discardedAt") = 0
  WHEN 'PUBLISHED' THEN num_nonnulls("publishedById", "publishedAt") = 2 AND num_nonnulls("supersededById", "supersededAt", "discardedById", "discardedAt") = 0
  WHEN 'SUPERSEDED' THEN num_nonnulls("publishedById", "publishedAt", "supersededById", "supersededAt") = 4 AND num_nonnulls("discardedById", "discardedAt") = 0
  WHEN 'DISCARDED' THEN num_nonnulls("discardedById", "discardedAt") = 2 AND num_nonnulls("publishedById", "publishedAt", "supersededById", "supersededAt") = 0
END);
-- Four-eyes: a guide goes live on a second person's word.
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_four_eyes" CHECK ("publishedById" IS NULL OR "publishedById" <> "uploadedById");

-- One current guide per name; the same file is loaded once while it is live.
CREATE UNIQUE INDEX "ValuationGuide_one_current_per_name" ON "ValuationGuide" ("tenantId", lower("name")) WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "ValuationGuide_live_file" ON "ValuationGuide" ("tenantId", "fileSha256") WHERE "status" IN ('DRAFT', 'PUBLISHED');

-- A guide is loaded as a DRAFT and is never deleted. It moves only DRAFT →
-- PUBLISHED (with every row it was loaded with, on or after its effective
-- date) or DISCARDED, and PUBLISHED → SUPERSEDED (by a guide of the same name
-- dated on or after it). A move changes only the status and who made it,
-- when: a published guide never changes.
CREATE OR REPLACE FUNCTION public."guardValuationGuide"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  allowed TEXT[];
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A valuation guide is never deleted: discard a draft';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A valuation guide is loaded as a DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  allowed := CASE OLD."status"::TEXT || '>' || NEW."status"::TEXT
    WHEN 'DRAFT>PUBLISHED' THEN ARRAY['status', 'publishedById', 'publishedAt']
    WHEN 'DRAFT>DISCARDED' THEN ARRAY['status', 'discardedById', 'discardedAt']
    WHEN 'PUBLISHED>SUPERSEDED' THEN ARRAY['status', 'supersededById', 'supersededAt']
  END;
  IF allowed IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A valuation guide moves only from DRAFT to PUBLISHED or DISCARDED, and from PUBLISHED to SUPERSEDED: not %s to %s', OLD."status", NEW."status");
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A valuation guide changes only its status and who moved it, when: its name, date, source, file and rows never change';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' THEN
    IF NEW."effectiveOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is published on or after its effective date';
    END IF;
    IF (SELECT count(*) FROM "ValuationGuideRow" r WHERE r."tenantId" = NEW."tenantId" AND r."guideId" = NEW."id") <> NEW."rowCount" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is published with every row it was loaded with';
    END IF;
  ELSIF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED' THEN
    IF NOT EXISTS (SELECT 1 FROM "ValuationGuide" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."supersededById" AND g."id" <> NEW."id"
        AND lower(g."name") = lower(NEW."name") AND g."effectiveOn" >= NEW."effectiveOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is superseded by another guide of the same name dated on or after it';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ValuationGuide_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ValuationGuide"
  FOR EACH ROW EXECUTE FUNCTION public."guardValuationGuide"();
CREATE TRIGGER "ValuationGuide_no_truncate" BEFORE TRUNCATE ON "ValuationGuide"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardValuationGuide"();

-- Nobody takes a guide down without putting its replacement live: at commit,
-- a superseded guide's successor is published (or itself since superseded).
CREATE OR REPLACE FUNCTION public."checkValuationGuideSuccessor"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM "ValuationGuide" g
      WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."supersededById" AND g."status" IN ('PUBLISHED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A superseded guide''s successor is published by the end of its transaction';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "ValuationGuide_successor_published" AFTER UPDATE OF "status" ON "ValuationGuide"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkValuationGuideSuccessor"();

-- Rows ----------------------------------------------------------------------

ALTER TABLE "ValuationGuideRow" ADD CONSTRAINT "ValuationGuideRow_text" CHECK (
  "make" = btrim("make") AND length("make") BETWEEN 1 AND 100
  AND "model" = btrim("model") AND length("model") BETWEEN 1 AND 100
  AND "variant" = btrim("variant") AND length("variant") <= 100
);
ALTER TABLE "ValuationGuideRow" ADD CONSTRAINT "ValuationGuideRow_year" CHECK ("year" BETWEEN 1950 AND 2100);
ALTER TABLE "ValuationGuideRow" ADD CONSTRAINT "ValuationGuideRow_amounts" CHECK ("tradeCents" > 0 AND "tradeCents" <= "retailCents");
-- Line 1 is the header.
ALTER TABLE "ValuationGuideRow" ADD CONSTRAINT "ValuationGuideRow_line" CHECK ("lineNumber" >= 2);
CREATE UNIQUE INDEX "ValuationGuideRow_line_key" ON "ValuationGuideRow" ("tenantId", "guideId", "lineNumber");
-- One row per make, model, year and variant in a guide, case ignored (also the lookup's index).
CREATE UNIQUE INDEX "ValuationGuideRow_key" ON "ValuationGuideRow" ("tenantId", "guideId", lower("make"), lower("model"), "year", lower("variant"));

-- Rows are written into a DRAFT only (the guide row is share-locked, so a
-- concurrent publish waits and counts them), and never changed or deleted.
CREATE OR REPLACE FUNCTION public."guardValuationGuideRow"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  guide_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide row is never changed or deleted: load a new guide';
  END IF;
  SELECT g."status"::TEXT INTO guide_status FROM "ValuationGuide" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."guideId" FOR SHARE;
  IF guide_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rows are added to a DRAFT guide only';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ValuationGuideRow_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ValuationGuideRow"
  FOR EACH ROW EXECUTE FUNCTION public."guardValuationGuideRow"();
CREATE TRIGGER "ValuationGuideRow_no_truncate" BEFORE TRUNCATE ON "ValuationGuideRow"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardValuationGuideRow"();

-- GUIDE valuations ------------------------------------------------------------

-- A GUIDE valuation names a guide and one of its rows (the composite FKs above
-- keep both the lender's own), and only a GUIDE valuation does.
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_guide_shape" CHECK (
  ("source" = 'GUIDE') = ("guideId" IS NOT NULL) AND num_nonnulls("guideId", "guideRowId", "guideSnapshot") IN (0, 3)
);

-- A GUIDE valuation reads a published guide in force on its date, which is the
-- day it is read, for a row of the asset's make, model and year, at the row's
-- trade value. The database writes the snapshot of what it read. (Never edited:
-- guardAssetValuation refuses every UPDATE.)
CREATE OR REPLACE FUNCTION public."guardAssetValuationGuide"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  guide RECORD;
  guide_row RECORD;
  asset RECORD;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF NEW."source" <> 'GUIDE' THEN
    RETURN NEW;
  END IF;
  IF NEW."guideSnapshot" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide valuation''s snapshot is written by the database';
  END IF;
  SELECT g."id", g."name", g."effectiveOn", g."provider", g."simulated", g."status"::TEXT AS status INTO guide
    FROM "ValuationGuide" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."guideId" FOR SHARE;
  IF guide."id" IS NULL OR guide.status <> 'PUBLISHED' OR guide."effectiveOn" > NEW."valuedOn" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide valuation reads a published guide in force on its date';
  END IF;
  IF NEW."valuedOn" <> today THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide valuation is dated the day it is read';
  END IF;
  SELECT r."id", r."lineNumber", r."make", r."model", r."year", r."variant", r."tradeCents", r."retailCents" INTO guide_row
    FROM "ValuationGuideRow" r WHERE r."tenantId" = NEW."tenantId" AND r."guideId" = NEW."guideId" AND r."id" = NEW."guideRowId";
  SELECT a."make", a."model", a."year" INTO asset FROM "FinancedAsset" a WHERE a."tenantId" = NEW."tenantId" AND a."id" = NEW."assetId";
  IF guide_row."id" IS NULL OR lower(btrim(asset."make")) IS DISTINCT FROM lower(guide_row."make")
     OR lower(btrim(asset."model")) IS DISTINCT FROM lower(guide_row."model") OR asset."year" IS DISTINCT FROM guide_row."year" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide valuation reads a row for the asset''s make, model and year';
  END IF;
  IF NEW."amountCents" IS DISTINCT FROM guide_row."tradeCents" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide valuation''s amount is the row''s trade value';
  END IF;
  NEW."guideSnapshot" := jsonb_build_object(
    'guideId', guide."id", 'guideName', guide."name", 'effectiveOn', guide."effectiveOn", 'provider', guide."provider", 'simulated', guide."simulated",
    'rowId', guide_row."id", 'lineNumber', guide_row."lineNumber", 'make', guide_row."make", 'model', guide_row."model", 'year', guide_row."year",
    'variant', guide_row."variant", 'tradeCents', guide_row."tradeCents", 'retailCents', guide_row."retailCents");
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetValuation_guide_guard" BEFORE INSERT ON "AssetValuation"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetValuationGuide"();

-- Tenant isolation (as 20261015130000_tenant_rls_new_scoped_models) ----------

ALTER TABLE "ValuationGuide" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ValuationGuide" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ValuationGuide" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "ValuationGuideRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ValuationGuideRow" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ValuationGuideRow" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
