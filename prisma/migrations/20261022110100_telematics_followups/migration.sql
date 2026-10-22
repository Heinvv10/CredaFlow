-- CreateEnum
CREATE TYPE "AssetMeterReadingVoidStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TelematicsPositionView" AS ENUM ('LATEST', 'TRAIL');


-- DropIndex
DROP INDEX "TelematicsPosition_tenantId_deviceId_key";

-- AlterTable
ALTER TABLE "AssetMeterReading" ADD COLUMN     "voidId" TEXT,
ADD COLUMN     "voidedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TelematicsPositionAccess" ADD COLUMN     "positionCount" INTEGER,
ADD COLUMN     "theftReportId" TEXT,
ADD COLUMN     "view" "TelematicsPositionView" NOT NULL DEFAULT 'LATEST';

-- CreateTable
CREATE TABLE "AssetMeterReadingVoid" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "readingId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AssetMeterReadingVoidStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AssetMeterReadingVoid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetTheftReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sapsCaseNumber" TEXT NOT NULL,
    "reportedOn" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "renewsReportId" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetTheftReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackerClosure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL,
    "noticeLoggedAt" TIMESTAMP(3),
    "messageOutcome" TEXT,
    "messageNote" TEXT,
    "messageId" TEXT,
    "messageDecidedAt" TIMESTAMP(3),
    "letterStoragePath" TEXT,
    "letterSha256" TEXT,
    "letterGeneratedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackerClosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetMeterReadingVoid_tenantId_readingId_idx" ON "AssetMeterReadingVoid"("tenantId", "readingId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeterReadingVoid_tenantId_id_key" ON "AssetMeterReadingVoid"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AssetTheftReport_tenantId_loanId_validUntil_idx" ON "AssetTheftReport"("tenantId", "loanId", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AssetTheftReport_tenantId_id_key" ON "AssetTheftReport"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TrackerClosure_tenantId_removedAt_idx" ON "TrackerClosure"("tenantId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerClosure_tenantId_id_key" ON "TrackerClosure"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerClosure_tenantId_loanId_deviceId_key" ON "TrackerClosure"("tenantId", "loanId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeterReading_tenantId_voidId_key" ON "AssetMeterReading"("tenantId", "voidId");

-- CreateIndex
CREATE INDEX "TelematicsPosition_tenantId_deviceId_occurredAt_idx" ON "TelematicsPosition"("tenantId", "deviceId", "occurredAt");

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_voidId_fkey" FOREIGN KEY ("tenantId", "voidId") REFERENCES "AssetMeterReadingVoid"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_tenantId_readingId_fkey" FOREIGN KEY ("tenantId", "readingId") REFERENCES "AssetMeterReading"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPositionAccess" ADD CONSTRAINT "TelematicsPositionAccess_tenantId_theftReportId_fkey" FOREIGN KEY ("tenantId", "theftReportId") REFERENCES "AssetTheftReport"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_tenantId_renewsReportId_fkey" FOREIGN KEY ("tenantId", "renewsReportId") REFERENCES "AssetTheftReport"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerClosure" ADD CONSTRAINT "TrackerClosure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackerClosure" ADD CONSTRAINT "TrackerClosure_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerClosure" ADD CONSTRAINT "TrackerClosure_tenantId_deviceId_fkey" FOREIGN KEY ("tenantId", "deviceId") REFERENCES "TrackerDevice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerClosure" ADD CONSTRAINT "TrackerClosure_tenantId_removedById_fkey" FOREIGN KEY ("tenantId", "removedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written (docs/asset-finance/SLICE5-FOLLOWUPS.md part T). Errors
-- RAISE ... USING ERRCODE = '23514'. Today = the SAST calendar date.
-- ---------------------------------------------------------------------------

ALTER TABLE "AssetTheftReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetTheftReport" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetTheftReport" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "AssetMeterReadingVoid" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetMeterReadingVoid" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AssetMeterReadingVoid" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TrackerClosure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrackerClosure" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TrackerClosure" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- ---------------------------------------------------------------------------
-- 1. Theft reports and the THEFT purpose
-- ---------------------------------------------------------------------------

-- SAPS's case number: "CAS <sequence>/<month>/<year>" (stored normalised).
ALTER TABLE "AssetTheftReport" ADD CONSTRAINT "AssetTheftReport_case_number"
  CHECK ("sapsCaseNumber" ~ '^CAS [1-9][0-9]{0,5}/(0?[1-9]|1[0-2])/[0-9]{4}$');

-- Recorded on a running loan of the report's asset, reported to SAPS no
-- later than today and not before the loan started, the case's year no later
-- than this year; valid for 30 days from the day it is recorded (the database
-- sets validUntil). A renewal names a report of the same loan and case. Never
-- changed or deleted.
CREATE OR REPLACE FUNCTION "guardAssetTheftReport"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  loan_row RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A theft report is never changed or deleted: record a renewal or a new report';
  END IF;
  SELECT l."assetId", l."status", (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date AS "startedOn" INTO loan_row
  FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  IF NOT FOUND OR loan_row."assetId" IS DISTINCT FROM NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A theft report is of the loan''s own asset';
  END IF;
  IF loan_row."status"::text NOT IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A theft report is recorded on a running loan';
  END IF;
  IF NEW."reportedOn" > today OR NEW."reportedOn" < loan_row."startedOn"
     OR split_part(NEW."sapsCaseNumber", '/', 3)::int > extract(year FROM today)::int THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A theft is reported to SAPS no later than today and not before the loan started';
  END IF;
  IF NEW."renewsReportId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AssetTheftReport" r WHERE r."id" = NEW."renewsReportId" AND r."tenantId" = NEW."tenantId"
      AND r."loanId" = NEW."loanId" AND r."sapsCaseNumber" = NEW."sapsCaseNumber") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A renewal names a report of the same loan and case';
  END IF;
  NEW."recordedAt" := CURRENT_TIMESTAMP;
  NEW."validUntil" := today + 30;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetTheftReport_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssetTheftReport"
  FOR EACH ROW EXECUTE FUNCTION "guardAssetTheftReport"();
CREATE TRIGGER "AssetTheftReport_no_truncate" BEFORE TRUNCATE ON "AssetTheftReport"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardAssetTheftReport"();

-- The one definition of whether a loan has a purpose for showing its asset's
-- position now: DEFAULT (DEFAULTED or PENDING_WRITE_OFF), RECOVERY (a
-- recovery not CLOSED or WITHDRAWN), LEGAL_MATTER (an OPEN matter), THEFT
-- (the named report is the loan's and valid today, on a running loan).
CREATE OR REPLACE FUNCTION "telematicsPurposeHolds"(tenant_id TEXT, loan_id TEXT, context "TelematicsPositionContext", theft_report_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE context
    WHEN 'DEFAULT' THEN EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = loan_id AND l."tenantId" = tenant_id
      AND l."status"::text IN ('DEFAULTED', 'PENDING_WRITE_OFF'))
    WHEN 'RECOVERY' THEN EXISTS (SELECT 1 FROM "Recovery" r WHERE r."loanId" = loan_id AND r."tenantId" = tenant_id
      AND r."status"::text NOT IN ('CLOSED', 'WITHDRAWN'))
    WHEN 'LEGAL_MATTER' THEN EXISTS (SELECT 1 FROM "LegalMatter" m WHERE m."loanId" = loan_id AND m."tenantId" = tenant_id
      AND m."status"::text = 'OPEN')
    WHEN 'THEFT' THEN EXISTS (SELECT 1 FROM "AssetTheftReport" t JOIN "Loan" l ON l."id" = t."loanId" AND l."tenantId" = t."tenantId"
      WHERE t."id" = theft_report_id AND t."tenantId" = tenant_id AND t."loanId" = loan_id
        AND t."validUntil" >= (now() AT TIME ZONE 'Africa/Johannesburg')::date
        AND l."status"::text IN ('ACTIVE', 'DEFAULTED', 'PENDING_WRITE_OFF'))
    ELSE FALSE
  END
$function$;

-- The position access log (20261020160100, re-created): insert-only, by a
-- user of the tenant, for a loan on the asset and a device of that asset;
-- and now the purpose must hold when the row is written (the gate was
-- TypeScript only). A TRAIL view is never for DEFAULT and records its point
-- count; a THEFT view names its report, no other view does.
CREATE OR REPLACE FUNCTION public."guardTelematicsPositionAccess"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The position access log is append-only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."assetId")
     OR (NEW."deviceId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "TrackerDevice" d WHERE d."id" = NEW."deviceId" AND d."tenantId" = NEW."tenantId" AND d."assetId" = NEW."assetId")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A position access names a loan on its asset and a device of that asset';
  END IF;
  IF (NEW."context" = 'THEFT') <> (NEW."theftReportId" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A THEFT position access names its theft report; no other access does';
  END IF;
  IF NEW."view" = 'TRAIL' AND (NEW."context" = 'DEFAULT' OR NEW."positionCount" IS NULL OR NEW."positionId" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A trail is shown for theft, recovery or a legal matter, with its point count';
  END IF;
  IF NEW."view" = 'LATEST' AND NEW."positionCount" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A latest-position access has no point count';
  END IF;
  IF NOT "telematicsPurposeHolds"(NEW."tenantId", NEW."loanId", NEW."context", NEW."theftReportId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A position is shown only for a purpose the loan has now';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The trail: every position kept (the per-device unique is dropped above).
-- guardTelematicsPosition is unchanged: stored only inside a tenure and
-- within retention, never changed, deleted by the purge.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3. Meter-reading voids (four-eyes)
-- ---------------------------------------------------------------------------

ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_reason"
  CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500);
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_decision_shape"
  CHECK (("status" = 'PENDING') = ("decidedById" IS NULL) AND ("decidedById" IS NULL) = ("decidedAt" IS NULL));
ALTER TABLE "AssetMeterReadingVoid" ADD CONSTRAINT "AssetMeterReadingVoid_four_eyes"
  CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");
CREATE UNIQUE INDEX "AssetMeterReadingVoid_one_open" ON "AssetMeterReadingVoid" ("tenantId", "readingId") WHERE "status" = 'PENDING';

-- Why a reading may not be voided now, or NULL: already void; the final
-- reading of an end of term; a recovery's or maintenance claim's reading; a
-- reading of a lease whose end of term is invoiced (the invoice used its
-- start and final readings).
CREATE OR REPLACE FUNCTION "meterReadingVoidRefusal"(tenant_id TEXT, reading_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $function$
  SELECT CASE
    WHEN m."voidedAt" IS NOT NULL THEN 'This reading is already void'
    WHEN EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."tenantId" = m."tenantId" AND e."finalReadingId" = m."id")
      THEN 'The final reading of an end of term is not voided'
    WHEN EXISTS (SELECT 1 FROM "Recovery" r WHERE r."tenantId" = m."tenantId" AND r."meterReadingId" = m."id")
      OR EXISTS (SELECT 1 FROM "MaintenanceClaim" c WHERE c."tenantId" = m."tenantId" AND c."meterReadingId" = m."id")
      THEN 'A reading a recovery or a maintenance claim relies on is not voided'
    WHEN m."loanId" IS NOT NULL AND EXISTS (SELECT 1 FROM "LeaseEndOfTerm" e WHERE e."tenantId" = m."tenantId" AND e."loanId" = m."loanId"
      AND e."taxInvoiceId" IS NOT NULL)
      THEN 'The lease''s end of term is invoiced: its readings are billed'
  END
  FROM "AssetMeterReading" m WHERE m."id" = reading_id AND m."tenantId" = tenant_id
$function$;

-- Requested PENDING with a reason; decided once, APPROVED or REJECTED, by a
-- second user (CHECK); nothing else changes; never deleted. A request and an
-- approval both need the reading voidable at that moment.
CREATE OR REPLACE FUNCTION "guardAssetMeterReadingVoid"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  refusal TEXT;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter-reading void is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter-reading void is requested PENDING';
    END IF;
  ELSE
    IF OLD."status" <> 'PENDING' OR NEW."status" = 'PENDING'
       OR (to_jsonb(NEW) - ARRAY['status', 'decidedById', 'decidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decidedById', 'decidedAt']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter-reading void is decided once, and nothing else about it changes';
    END IF;
    IF NEW."status" = 'REJECTED' THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Serialise with the reading (an end of term or claim naming it meanwhile).
  PERFORM 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."readingId" AND m."tenantId" = NEW."tenantId" FOR UPDATE;
  refusal := "meterReadingVoidRefusal"(NEW."tenantId", NEW."readingId");
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = refusal;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetMeterReadingVoid_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AssetMeterReadingVoid"
  FOR EACH ROW EXECUTE FUNCTION "guardAssetMeterReadingVoid"();
CREATE TRIGGER "AssetMeterReadingVoid_no_truncate" BEFORE TRUNCATE ON "AssetMeterReadingVoid"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardAssetMeterReadingVoid"();

-- The approval stamps the reading.
CREATE OR REPLACE FUNCTION "applyAssetMeterReadingVoid"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'APPROVED' AND OLD."status" = 'PENDING' THEN
    UPDATE "AssetMeterReading" SET "voidedAt" = NEW."decidedAt", "voidId" = NEW."id"
    WHERE "id" = NEW."readingId" AND "tenantId" = NEW."tenantId";
  END IF;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "AssetMeterReadingVoid_apply" AFTER UPDATE OF "status" ON "AssetMeterReadingVoid"
  FOR EACH ROW EXECUTE FUNCTION "applyAssetMeterReadingVoid"();

-- guardAssetMeterReading (20261014100000, re-created): a reading is
-- immutable but for one change, its void (voidedAt and voidId set once, by an
-- APPROVED void of this reading); and a voided reading counts for nothing in
-- the monotonic rule. Otherwise unchanged.
CREATE OR REPLACE FUNCTION public."guardAssetMeterReading"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."voidedAt" IS NULL AND NEW."voidedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['voidedAt', 'voidId']) = (to_jsonb(OLD) - ARRAY['voidedAt', 'voidId'])
       AND EXISTS (SELECT 1 FROM "AssetMeterReadingVoid" v WHERE v."id" = NEW."voidId" AND v."tenantId" = NEW."tenantId"
         AND v."readingId" = NEW."id" AND v."status" = 'APPROVED' AND v."decidedAt" = NEW."voidedAt") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is immutable: only an approved void marks it';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is immutable';
  END IF;
  IF NEW."voidedAt" IS NOT NULL OR NEW."voidId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is recorded before it is voided';
  END IF;
  -- Never in the future (but for the start reading, dated the lease's start);
  -- a lease's reading is of its own asset, from its start.
  IF (NEW."readingDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date AND NOT EXISTS (
      SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND NEW."readingDate" = (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date))
    OR (NEW."loanId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."assetId"
        AND NEW."readingDate" >= (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter reading is dated no later than today, of its lease''s asset, from the lease''s start';
  END IF;
  -- Serialise readings of one asset: lock it.
  PERFORM 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "AssetMeterReading" r WHERE r."tenantId" = NEW."tenantId" AND r."assetId" = NEW."assetId" AND r."unit" = NEW."unit"
      AND r."voidedAt" IS NULL
      AND ((r."readingDate" <= NEW."readingDate" AND r."value" > NEW."value") OR (r."readingDate" > NEW."readingDate" AND r."value" < NEW."value"))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Meter readings are monotonic: never below an earlier (or same-day) reading nor above a later-dated one';
  END IF;
  RETURN NEW;
END;
$function$;

-- A voided reading is not cited: not as an end of term's final reading, a
-- recovery's or a claim's.
CREATE OR REPLACE FUNCTION "guardNotVoidedReading"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  reading_id TEXT;
BEGIN
  -- Each table names the reading in its own column (NEW's fields are resolved per branch, so not one CASE).
  IF TG_TABLE_NAME = 'LeaseEndOfTerm' THEN
    reading_id := NEW."finalReadingId";
  ELSE
    reading_id := NEW."meterReadingId";
  END IF;
  IF reading_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = reading_id AND m."tenantId" = NEW."tenantId" AND m."voidedAt" IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A voided meter reading is not relied on';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LeaseEndOfTerm_not_voided_reading" BEFORE INSERT OR UPDATE OF "finalReadingId" ON "LeaseEndOfTerm"
  FOR EACH ROW EXECUTE FUNCTION "guardNotVoidedReading"();
CREATE TRIGGER "Recovery_not_voided_reading" BEFORE INSERT OR UPDATE OF "meterReadingId" ON "Recovery"
  FOR EACH ROW EXECUTE FUNCTION "guardNotVoidedReading"();
CREATE TRIGGER "MaintenanceClaim_not_voided_reading" BEFORE INSERT OR UPDATE OF "meterReadingId" ON "MaintenanceClaim"
  FOR EACH ROW EXECUTE FUNCTION "guardNotVoidedReading"();

-- telematicsPaceCeiling (20261020160100, re-created): the start reading is
-- the earliest that is not void.
CREATE OR REPLACE FUNCTION public."telematicsPaceCeiling"(tenant_id TEXT, loan_id TEXT, on_date DATE)
RETURNS INTEGER LANGUAGE sql STABLE AS $function$
  SELECT (s."value" + ceil(d."usageAllowancePerYear"::numeric * 3 * ((on_date - s."readingDate") + 31) / 365))::integer
  FROM "AssetFinanceDeal" d
  JOIN LATERAL (
    SELECT r."value", r."readingDate" FROM "AssetMeterReading" r
    WHERE r."tenantId" = tenant_id AND r."loanId" = loan_id AND r."unit" = d."usageUnit" AND r."voidedAt" IS NULL
    ORDER BY r."readingDate", r."value" LIMIT 1
  ) s ON TRUE
  WHERE d."tenantId" = tenant_id AND d."loanId" = loan_id AND d."usageAllowancePerYear" IS NOT NULL;
$function$;

-- One live telematics reading per lease per SAST day: a voided one leaves room.
DROP INDEX "AssetMeterReading_telematics_one_per_day";
CREATE UNIQUE INDEX "AssetMeterReading_telematics_one_per_day" ON "AssetMeterReading" ("tenantId", "loanId", "readingDate")
  WHERE "source" = 'TELEMATICS' AND "voidedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Closure: a tracker on a loan that completes
-- ---------------------------------------------------------------------------

-- When a loan moves into COMPLETED (any path), one TrackerClosure per ACTIVE
-- device on its asset: the staff removal task and the record of the
-- borrower's notices. Once per loan and device.
CREATE OR REPLACE FUNCTION "createTrackerClosures"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status"::text <> 'COMPLETED' OR NEW."assetId" IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO "TrackerClosure" ("id", "tenantId", "loanId", "deviceId", "closedAt")
  SELECT 'trc_' || replace(gen_random_uuid()::TEXT, '-', ''), NEW."tenantId", NEW."id", d."id", COALESCE(NEW."closedAt", CURRENT_TIMESTAMP)
  FROM "TrackerDevice" d
  WHERE d."tenantId" = NEW."tenantId" AND d."assetId" = NEW."assetId" AND d."status" = 'ACTIVE'
  ON CONFLICT ("tenantId", "loanId", "deviceId") DO NOTHING;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "Loan_tracker_closure" AFTER UPDATE OF "status" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION "createTrackerClosures"();

-- Written for a COMPLETED loan and an ACTIVE device on its asset; the loan,
-- device and closing time are fixed; each effect is recorded once (its
-- columns go from empty to set, never back or again); the removal needs the
-- device REMOVED. Never deleted.
CREATE OR REPLACE FUNCTION "guardTrackerClosure"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker closure is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Loan" l JOIN "TrackerDevice" d ON d."tenantId" = l."tenantId" AND d."assetId" = l."assetId"
      WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."status"::text = 'COMPLETED'
        AND d."id" = NEW."deviceId" AND d."status" = 'ACTIVE')
      OR num_nonnulls(NEW."noticeLoggedAt", NEW."messageOutcome", NEW."messageDecidedAt", NEW."letterStoragePath", NEW."removedAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker closure is opened for a completed loan''s active device, with nothing done yet';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."loanId", NEW."deviceId", NEW."closedAt", NEW."createdAt")
       IS DISTINCT FROM (OLD."tenantId", OLD."loanId", OLD."deviceId", OLD."closedAt", OLD."createdAt")
     OR (OLD."noticeLoggedAt" IS NOT NULL AND NEW."noticeLoggedAt" IS DISTINCT FROM OLD."noticeLoggedAt")
     OR (OLD."messageDecidedAt" IS NOT NULL AND (NEW."messageDecidedAt", NEW."messageOutcome", NEW."messageNote", NEW."messageId")
           IS DISTINCT FROM (OLD."messageDecidedAt", OLD."messageOutcome", OLD."messageNote", OLD."messageId"))
     OR (OLD."letterGeneratedAt" IS NOT NULL AND (NEW."letterGeneratedAt", NEW."letterStoragePath", NEW."letterSha256")
           IS DISTINCT FROM (OLD."letterGeneratedAt", OLD."letterStoragePath", OLD."letterSha256"))
     OR (OLD."removedAt" IS NOT NULL AND (NEW."removedAt", NEW."removedById") IS DISTINCT FROM (OLD."removedAt", OLD."removedById")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Each step of a tracker closure is recorded once';
  END IF;
  IF NEW."removedAt" IS NOT NULL AND OLD."removedAt" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "TrackerDevice" d WHERE d."id" = NEW."deviceId" AND d."tenantId" = NEW."tenantId" AND d."status" = 'REMOVED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker closure is done when its device is removed';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE "TrackerClosure" ADD CONSTRAINT "TrackerClosure_shape" CHECK (
  ("messageDecidedAt" IS NULL) = ("messageOutcome" IS NULL)
  AND ("messageOutcome" IS NULL OR "messageOutcome" IN ('SENT', 'SIMULATED', 'BLOCKED', 'FAILED'))
  AND ("letterGeneratedAt" IS NULL) = ("letterStoragePath" IS NULL) AND ("letterStoragePath" IS NULL) = ("letterSha256" IS NULL)
  AND ("removedAt" IS NULL) = ("removedById" IS NULL)
);

CREATE TRIGGER "TrackerClosure_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TrackerClosure"
  FOR EACH ROW EXECUTE FUNCTION "guardTrackerClosure"();
CREATE TRIGGER "TrackerClosure_no_truncate" BEFORE TRUNCATE ON "TrackerClosure"
  FOR EACH STATEMENT EXECUTE FUNCTION "guardTrackerClosure"();
