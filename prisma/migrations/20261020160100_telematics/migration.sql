-- CreateEnum
CREATE TYPE "TrackerDeviceStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "TelematicsEventKind" AS ENUM ('HEARTBEAT', 'POSITION', 'METER', 'IGNITION', 'ALERT');

-- CreateEnum
CREATE TYPE "TelematicsAlertKind" AS ENUM ('TAMPER', 'POWER_CUT', 'GEOFENCE_EXIT');

-- CreateEnum
CREATE TYPE "TelematicsMeterOutcome" AS ENUM ('RECORDED', 'HELD', 'SAME_DAY', 'NOT_LEASE', 'LEASE_NOT_RUNNING', 'NO_USAGE_TERMS', 'METER_UNVERIFIED');

-- CreateEnum
CREATE TYPE "TelematicsHeldReason" AS ENUM ('LOWER', 'ABOVE_LATER', 'IMPLAUSIBLE');

-- CreateEnum
CREATE TYPE "TelematicsHeldStatus" AS ENUM ('HELD', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TelematicsAlertQueue" AS ENUM ('SERVICING', 'COLLECTIONS', 'RECOVERY');

-- CreateEnum
CREATE TYPE "TelematicsAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TelematicsPositionContext" AS ENUM ('DEFAULT', 'RECOVERY', 'LEGAL_MATTER');

-- AlterTable
ALTER TABLE "AssetMeterReading" ADD COLUMN     "telematicsEventId" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "telematicsPositionRetentionDays" INTEGER NOT NULL DEFAULT 90;

-- CreateTable
CREATE TABLE "TrackerDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalDeviceId" TEXT NOT NULL,
    "installedOn" DATE NOT NULL,
    "status" "TrackerDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "removedOn" DATE,
    "removedById" TEXT,
    "createdById" TEXT NOT NULL,
    "pollCursor" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "lastPollError" TEXT,
    "meterVerifiedAt" TIMESTAMP(3),
    "meterVerifiedById" TEXT,
    "meterVerifiedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackerDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelematicsEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "kind" "TelematicsEventKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meterValue" INTEGER,
    "meterUnit" "UsageUnit",
    "ignitionOn" BOOLEAN,
    "alertKind" "TelematicsAlertKind",
    "simulated" BOOLEAN NOT NULL,
    "meterOutcome" "TelematicsMeterOutcome",

    CONSTRAINT "TelematicsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelematicsPosition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracyM" INTEGER,

    CONSTRAINT "TelematicsPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelematicsHeldReading" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "readingDate" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "unit" "UsageUnit" NOT NULL,
    "reason" "TelematicsHeldReason" NOT NULL,
    "status" "TelematicsHeldStatus" NOT NULL DEFAULT 'HELD',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "meterReadingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelematicsHeldReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelematicsAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "kind" "TelematicsAlertKind" NOT NULL,
    "queue" "TelematicsAlertQueue" NOT NULL,
    "status" "TelematicsAlertStatus" NOT NULL DEFAULT 'OPEN',
    "firstOccurredAt" TIMESTAMP(3) NOT NULL,
    "lastOccurredAt" TIMESTAMP(3) NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelematicsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelematicsPositionAccess" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "deviceId" TEXT,
    "context" "TelematicsPositionContext" NOT NULL,
    "positionId" TEXT,
    "positionOccurredAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelematicsPositionAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackerDevice_tenantId_assetId_idx" ON "TrackerDevice"("tenantId", "assetId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackerDevice_tenantId_id_key" ON "TrackerDevice"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TelematicsEvent_tenantId_deviceId_kind_occurredAt_idx" ON "TelematicsEvent"("tenantId", "deviceId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "TelematicsEvent_tenantId_kind_occurredAt_idx" ON "TelematicsEvent"("tenantId", "kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsEvent_tenantId_id_key" ON "TelematicsEvent"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsEvent_tenantId_provider_providerEventId_key" ON "TelematicsEvent"("tenantId", "provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsPosition_eventId_key" ON "TelematicsPosition"("eventId");

-- CreateIndex
CREATE INDEX "TelematicsPosition_tenantId_occurredAt_idx" ON "TelematicsPosition"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsPosition_tenantId_id_key" ON "TelematicsPosition"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsPosition_tenantId_eventId_key" ON "TelematicsPosition"("tenantId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsPosition_tenantId_deviceId_key" ON "TelematicsPosition"("tenantId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_eventId_key" ON "TelematicsHeldReading"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_meterReadingId_key" ON "TelematicsHeldReading"("meterReadingId");

-- CreateIndex
CREATE INDEX "TelematicsHeldReading_tenantId_status_idx" ON "TelematicsHeldReading"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_tenantId_id_key" ON "TelematicsHeldReading"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_tenantId_eventId_key" ON "TelematicsHeldReading"("tenantId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_tenantId_meterReadingId_key" ON "TelematicsHeldReading"("tenantId", "meterReadingId");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsHeldReading_tenantId_loanId_readingDate_key" ON "TelematicsHeldReading"("tenantId", "loanId", "readingDate");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsAlert_eventId_key" ON "TelematicsAlert"("eventId");

-- CreateIndex
CREATE INDEX "TelematicsAlert_tenantId_queue_status_idx" ON "TelematicsAlert"("tenantId", "queue", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsAlert_tenantId_id_key" ON "TelematicsAlert"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsAlert_tenantId_eventId_key" ON "TelematicsAlert"("tenantId", "eventId");

-- CreateIndex
CREATE INDEX "TelematicsPositionAccess_tenantId_loanId_createdAt_idx" ON "TelematicsPositionAccess"("tenantId", "loanId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelematicsPositionAccess_tenantId_id_key" ON "TelematicsPositionAccess"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeterReading_telematicsEventId_key" ON "AssetMeterReading"("telematicsEventId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMeterReading_tenantId_telematicsEventId_key" ON "AssetMeterReading"("tenantId", "telematicsEventId");

-- AddForeignKey
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_tenantId_telematicsEventId_fkey" FOREIGN KEY ("tenantId", "telematicsEventId") REFERENCES "TelematicsEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_tenantId_removedById_fkey" FOREIGN KEY ("tenantId", "removedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_tenantId_meterVerifiedById_fkey" FOREIGN KEY ("tenantId", "meterVerifiedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsEvent" ADD CONSTRAINT "TelematicsEvent_tenantId_deviceId_fkey" FOREIGN KEY ("tenantId", "deviceId") REFERENCES "TrackerDevice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPosition" ADD CONSTRAINT "TelematicsPosition_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "TelematicsEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPosition" ADD CONSTRAINT "TelematicsPosition_tenantId_deviceId_fkey" FOREIGN KEY ("tenantId", "deviceId") REFERENCES "TrackerDevice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "TelematicsEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_tenantId_meterReadingId_fkey" FOREIGN KEY ("tenantId", "meterReadingId") REFERENCES "AssetMeterReading"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "TelematicsEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_deviceId_fkey" FOREIGN KEY ("tenantId", "deviceId") REFERENCES "TrackerDevice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_acknowledgedById_fkey" FOREIGN KEY ("tenantId", "acknowledgedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_tenantId_resolvedById_fkey" FOREIGN KEY ("tenantId", "resolvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPositionAccess" ADD CONSTRAINT "TelematicsPositionAccess_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPositionAccess" ADD CONSTRAINT "TelematicsPositionAccess_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPositionAccess" ADD CONSTRAINT "TelematicsPositionAccess_tenantId_assetId_fkey" FOREIGN KEY ("tenantId", "assetId") REFERENCES "FinancedAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TelematicsPositionAccess" ADD CONSTRAINT "TelematicsPositionAccess_tenantId_deviceId_fkey" FOREIGN KEY ("tenantId", "deviceId") REFERENCES "TrackerDevice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------
-- Hand-written: tracker devices, telematics events, positions, held readings,
-- alerts and the position access log (docs/asset-finance/SLICE5.md part B).
-- Every refusal is ERRCODE 23514. Today is the SAST calendar date.
-- ---------------------------------------------------------------------------

ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_telematics_retention_range"
  CHECK ("telematicsPositionRetentionDays" BETWEEN 1 AND 365);

ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_provider_key" CHECK ("provider" ~ '^[a-z0-9-]{1,40}$');
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_external_id" CHECK (length(btrim("externalDeviceId")) BETWEEN 1 AND 100);
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_status_shape" CHECK (CASE "status"
  WHEN 'ACTIVE' THEN "removedOn" IS NULL AND "removedById" IS NULL
  ELSE "removedOn" IS NOT NULL AND "removedById" IS NOT NULL END);
-- A meter verification is who, when and a note of 3 to 500 characters, or nothing.
ALTER TABLE "TrackerDevice" ADD CONSTRAINT "TrackerDevice_meter_verified_shape" CHECK (
  ("meterVerifiedAt" IS NULL) = ("meterVerifiedById" IS NULL) AND ("meterVerifiedAt" IS NULL) = ("meterVerifiedNote" IS NULL)
  AND ("meterVerifiedNote" IS NULL OR length(btrim("meterVerifiedNote")) BETWEEN 3 AND 500));
-- One live device per asset, and a provider's device on one asset at a time.
CREATE UNIQUE INDEX "TrackerDevice_one_active_per_asset" ON "TrackerDevice" ("tenantId", "assetId") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "TrackerDevice_one_active_per_external_id" ON "TrackerDevice" ("tenantId", "provider", "externalDeviceId") WHERE "status" = 'ACTIVE';

ALTER TABLE "TelematicsEvent" ADD CONSTRAINT "TelematicsEvent_kind_shape" CHECK (
  ("kind" = 'METER') = ("meterValue" IS NOT NULL) AND ("kind" = 'METER') = ("meterUnit" IS NOT NULL)
  AND ("meterValue" IS NULL OR "meterValue" >= 0)
  AND ("kind" = 'IGNITION') = ("ignitionOn" IS NOT NULL)
  AND ("kind" = 'ALERT') = ("alertKind" IS NOT NULL)
  AND ("kind" = 'METER' OR "meterOutcome" IS NULL));
ALTER TABLE "TelematicsEvent" ADD CONSTRAINT "TelematicsEvent_provider_event_id" CHECK (length("providerEventId") BETWEEN 1 AND 200);

ALTER TABLE "TelematicsPosition" ADD CONSTRAINT "TelematicsPosition_range" CHECK (
  "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND ("accuracyM" IS NULL OR "accuracyM" >= 0));

ALTER TABLE "TelematicsHeldReading" ADD CONSTRAINT "TelematicsHeldReading_decision_shape" CHECK (CASE "status"
  WHEN 'HELD' THEN "decidedById" IS NULL AND "decidedAt" IS NULL AND "meterReadingId" IS NULL AND "decisionNote" IS NULL
  WHEN 'ACCEPTED' THEN "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "meterReadingId" IS NOT NULL
    AND length(btrim(COALESCE("decisionNote", ''))) BETWEEN 3 AND 500
  ELSE "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "meterReadingId" IS NULL
    AND length(btrim(COALESCE("decisionNote", ''))) BETWEEN 3 AND 500 END);

ALTER TABLE "TelematicsAlert" ADD CONSTRAINT "TelematicsAlert_status_shape" CHECK (
  ("acknowledgedById" IS NULL) = ("acknowledgedAt" IS NULL)
  AND ("resolvedById" IS NULL) = ("resolvedAt" IS NULL)
  AND ("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
  AND ("status" <> 'OPEN' OR "acknowledgedAt" IS NULL)
  AND ("status" <> 'ACKNOWLEDGED' OR "acknowledgedAt" IS NOT NULL)
  AND CASE WHEN "status" = 'RESOLVED' THEN length(btrim(COALESCE("resolutionNote", ''))) BETWEEN 3 AND 500 ELSE "resolutionNote" IS NULL END
  AND "occurrences" >= 1 AND "lastOccurredAt" >= "firstOccurredAt");
-- Repeats fold into the unresolved item for the same device and kind.
CREATE UNIQUE INDEX "TelematicsAlert_one_unresolved" ON "TelematicsAlert" ("tenantId", "deviceId", "kind") WHERE "status" <> 'RESOLVED';

-- A TELEMATICS reading names its event and no client; one per lease per SAST day.
ALTER TABLE "AssetMeterReading" ADD CONSTRAINT "AssetMeterReading_telematics_shape" CHECK (
  ("source" = 'TELEMATICS') = ("telematicsEventId" IS NOT NULL) AND ("source" <> 'TELEMATICS' OR "recordedByClientId" IS NULL));
CREATE UNIQUE INDEX "AssetMeterReading_telematics_one_per_day" ON "AssetMeterReading" ("tenantId", "loanId", "readingDate") WHERE "source" = 'TELEMATICS';

-- The portal pace ceiling (lib/asset-finance/meter-readings.ts paceCeiling,
-- PORTAL_PACE_LIMIT 3) on `on_date`: the lease's start reading plus three times
-- the contracted yearly allowance, pro rata, with a month's grace. NULL when the
-- lease has no allowance or no reading.
CREATE OR REPLACE FUNCTION public."telematicsPaceCeiling"(tenant_id TEXT, loan_id TEXT, on_date DATE)
RETURNS INTEGER LANGUAGE sql STABLE AS $function$
  SELECT (s."value" + ceil(d."usageAllowancePerYear"::numeric * 3 * ((on_date - s."readingDate") + 31) / 365))::integer
  FROM "AssetFinanceDeal" d
  JOIN LATERAL (
    SELECT r."value", r."readingDate" FROM "AssetMeterReading" r
    WHERE r."tenantId" = tenant_id AND r."loanId" = loan_id AND r."unit" = d."usageUnit"
    ORDER BY r."readingDate", r."value" LIMIT 1
  ) s ON TRUE
  WHERE d."tenantId" = tenant_id AND d."loanId" = loan_id AND d."usageAllowancePerYear" IS NOT NULL;
$function$;

-- The agreement whose tenure of the asset covers `at` (POPIA: collection ends
-- with the agreement): an ACTIVE or DEFAULTED loan on the asset that started
-- on or before at's SAST day, with no later loan on the asset started by then
-- and no recovery of the asset under it (a withdrawn one aside: the asset went
-- back) dated on or before that day. NULL when none: no position is stored and
-- no alert raised.
CREATE OR REPLACE FUNCTION public."telematicsLoanAt"(tenant_id TEXT, asset_id TEXT, at TIMESTAMP)
RETURNS TEXT LANGUAGE sql STABLE AS $function$
  SELECT l."id" FROM "Loan" l
  WHERE l."tenantId" = tenant_id AND l."assetId" = asset_id AND l."status" IN ('ACTIVE', 'DEFAULTED')
    AND (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= (at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
    AND NOT EXISTS (SELECT 1 FROM "Loan" n WHERE n."tenantId" = tenant_id AND n."assetId" = asset_id AND n."id" <> l."id" AND n."startDate" > l."startDate"
      AND (n."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= (at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)
    AND NOT EXISTS (SELECT 1 FROM "Recovery" r WHERE r."tenantId" = tenant_id AND r."loanId" = l."id" AND r."status" <> 'WITHDRAWN'
      AND r."recoveredOn" <= (at AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)
  ORDER BY l."startDate" DESC LIMIT 1;
$function$;

-- Registered ACTIVE, installed no later than today; asset, provider, device
-- id, installation and creator fixed; ACTIVE -> REMOVED once, dated between
-- installation and today; a removed device is final; never deleted. Its
-- meter verification is set once, never at registration.
CREATE OR REPLACE FUNCTION public."guardTrackerDevice"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker device is never deleted; it is removed';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."installedOn" > today OR NEW."meterVerifiedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker device is registered ACTIVE and unverified, installed no later than today';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."assetId", NEW."provider", NEW."externalDeviceId", NEW."installedOn", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."assetId", OLD."provider", OLD."externalDeviceId", OLD."installedOn", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker device''s asset, provider, device id, installation date and creator are fixed';
  END IF;
  IF OLD."status" = 'REMOVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A removed tracker device is final';
  END IF;
  IF OLD."meterVerifiedAt" IS NOT NULL AND (NEW."meterVerifiedAt", NEW."meterVerifiedById", NEW."meterVerifiedNote")
     IS DISTINCT FROM (OLD."meterVerifiedAt", OLD."meterVerifiedById", OLD."meterVerifiedNote") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker device''s meter verification is set once';
  END IF;
  IF NEW."status" = 'REMOVED' AND NOT (NEW."removedOn" BETWEEN OLD."installedOn" AND today) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A tracker device is removed on a day between its installation and today';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TrackerDevice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TrackerDevice"
  FOR EACH ROW EXECUTE FUNCTION public."guardTrackerDevice"();
CREATE TRIGGER "TrackerDevice_no_truncate" BEFORE TRUNCATE ON "TrackerDevice"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTrackerDevice"();

-- Stored for an ACTIVE device of the tenant, under its provider, between the
-- device's installation (SAST) and five minutes from now. Immutable but for
-- a METER event's outcome, set once at ingest and consistent with what was
-- written then (a held reading accepted later keeps HELD).
-- Deleted only by the purge: a heartbeat, ignition or position event past the
-- tenant's retention. METER and ALERT events are business records.
CREATE OR REPLACE FUNCTION public."guardTelematicsEvent"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  device RECORD;
  retention INTEGER;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Telematics events are deleted only by the purge';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT c."telematicsPositionRetentionDays" INTO retention FROM "TenantConfig" c WHERE c."tenantId" = OLD."tenantId";
    IF NOT COALESCE(OLD."kind" IN ('HEARTBEAT', 'IGNITION', 'POSITION')
        AND OLD."occurredAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => retention), FALSE) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only a heartbeat, ignition or position event past the tenant''s retention is deleted (the purge)';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT d."status", d."provider", d."installedOn" INTO device FROM "TrackerDevice" d WHERE d."id" = NEW."deviceId" AND d."tenantId" = NEW."tenantId";
    IF NOT FOUND OR device."status" <> 'ACTIVE' OR device."provider" <> NEW."provider" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics event is of an active device of the tenant, under the device''s provider';
    END IF;
    IF NEW."occurredAt" > (now() AT TIME ZONE 'UTC') + INTERVAL '5 minutes'
       OR (NEW."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date < device."installedOn" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics event occurs between the device''s installation and now';
    END IF;
    IF NEW."meterOutcome" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics event''s meter outcome is set after the event is stored';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'meterOutcome') IS DISTINCT FROM (to_jsonb(OLD) - 'meterOutcome')
     OR OLD."meterOutcome" IS NOT NULL OR NEW."meterOutcome" IS NULL OR NEW."kind" <> 'METER' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics event is immutable but for a meter event''s outcome, set once';
  END IF;
  IF (NEW."meterOutcome" = 'RECORDED') <> EXISTS (
       SELECT 1 FROM "AssetMeterReading" m WHERE m."telematicsEventId" = NEW."id" AND m."tenantId" = NEW."tenantId")
     OR (NEW."meterOutcome" = 'HELD') <> EXISTS (
       SELECT 1 FROM "TelematicsHeldReading" h WHERE h."eventId" = NEW."id" AND h."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A meter event''s outcome at ingest is RECORDED exactly when its reading is written, and HELD exactly when it is held';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TelematicsEvent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TelematicsEvent"
  FOR EACH ROW EXECUTE FUNCTION public."guardTelematicsEvent"();
CREATE TRIGGER "TelematicsEvent_no_truncate" BEFORE TRUNCATE ON "TelematicsEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTelematicsEvent"();

-- A position is its POSITION or ALERT event's, on the event's device at its
-- time, while a running agreement on the asset covers that time
-- (telematicsLoanAt), and within the tenant's retention when stored (a stale
-- backfill is never kept). One per device (the latest: ingest deletes the
-- older one). Never changed. Deleted by ingest, the purge (or a DSAR erasure).
CREATE OR REPLACE FUNCTION public."guardTelematicsPosition"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  retention INTEGER;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Telematics positions are deleted by row (the purge), never truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics position is never changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "TelematicsEvent" e WHERE e."id" = NEW."eventId" AND e."tenantId" = NEW."tenantId"
      AND e."deviceId" = NEW."deviceId" AND e."occurredAt" = NEW."occurredAt" AND e."kind" IN ('POSITION', 'ALERT')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics position is its position or alert event''s, on that event''s device at its time';
  END IF;
  IF public."telematicsLoanAt"(NEW."tenantId", (SELECT d."assetId" FROM "TrackerDevice" d WHERE d."id" = NEW."deviceId" AND d."tenantId" = NEW."tenantId"), NEW."occurredAt") IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics position is stored only while a running agreement on its asset covers its time';
  END IF;
  SELECT c."telematicsPositionRetentionDays" INTO retention FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
  IF NOT COALESCE(NEW."occurredAt" >= (now() AT TIME ZONE 'UTC') - make_interval(days => retention), FALSE) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics position older than the tenant''s retention is not stored';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TelematicsPosition_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TelematicsPosition"
  FOR EACH ROW EXECUTE FUNCTION public."guardTelematicsPosition"();
CREATE TRIGGER "TelematicsPosition_no_truncate" BEFORE TRUNCATE ON "TelematicsPosition"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTelematicsPosition"();

-- A TELEMATICS reading (fires after AssetMeterReading_guard, which still owns
-- the date, immutability and monotonic rules): its METER event's value, unit,
-- SAST date and asset, from a simulated event or a device whose meter staff
-- verified; of an operating or full-maintenance lease of that asset while it
-- runs (ACTIVE or DEFAULTED, before the term ends, no total loss or early
-- termination, no accepted termination quote). Unattended (no recordedById)
-- it is not a held reading and keeps within the pace ceiling; recorded by
-- staff it is the acceptance of a HELD reading of that event and lease.
CREATE OR REPLACE FUNCTION public."guardTelematicsMeterReading"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  ev RECORD;
  loan_row RECORD;
BEGIN
  SELECT e."kind", e."meterValue", e."meterUnit", e."occurredAt", e."simulated", d."assetId", d."meterVerifiedAt" INTO ev
  FROM "TelematicsEvent" e JOIN "TrackerDevice" d ON d."id" = e."deviceId" AND d."tenantId" = e."tenantId"
  WHERE e."id" = NEW."telematicsEventId" AND e."tenantId" = NEW."tenantId";
  IF NOT FOUND OR ev."kind" <> 'METER' OR ev."meterValue" <> NEW."value" OR ev."meterUnit" <> NEW."unit"
     OR (ev."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <> NEW."readingDate" OR ev."assetId" <> NEW."assetId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics reading is its meter event''s value, unit, SAST date and asset';
  END IF;
  IF NOT ev."simulated" AND ev."meterVerifiedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics reading is from a simulated event or a device whose meter staff verified';
  END IF;
  SELECT l."contractType", l."status", l."assetId" INTO loan_row FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  IF NOT FOUND OR loan_row."assetId" IS DISTINCT FROM NEW."assetId"
     OR loan_row."contractType" IS NULL OR loan_row."contractType"::text NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics reading is of an operating or full-maintenance lease of its asset';
  END IF;
  IF loan_row."status"::text NOT IN ('ACTIVE', 'DEFAULTED')
     OR NEW."readingDate" >= COALESCE(public."leaseTermEnd"(NEW."loanId", NEW."tenantId"), NEW."readingDate")
     OR EXISTS (SELECT 1 FROM "LeaseEndOfTerm" x WHERE x."loanId" = NEW."loanId" AND x."tenantId" = NEW."tenantId"
       AND (x."outcome" = 'TOTAL_LOSS' OR x."origin" = 'EARLY_TERMINATION'))
     OR EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND q."status" = 'ACCEPTED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics reading is written only while the lease runs: before its term ends, with no total loss, early termination or accepted termination';
  END IF;
  IF NEW."recordedById" IS NULL THEN
    IF EXISTS (SELECT 1 FROM "TelematicsHeldReading" h WHERE h."eventId" = NEW."telematicsEventId" AND h."tenantId" = NEW."tenantId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A held telematics reading is written only by the staff member who accepts it';
    END IF;
    IF NEW."value" > public."telematicsPaceCeiling"(NEW."tenantId", NEW."loanId", NEW."readingDate") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An unattended telematics reading may not run ahead of three times the contracted pace since the lease''s start reading';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM "TelematicsHeldReading" h WHERE h."eventId" = NEW."telematicsEventId" AND h."tenantId" = NEW."tenantId" AND h."status" = 'HELD'
      AND h."loanId" = NEW."loanId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A staff-recorded telematics reading is the acceptance of a held reading of its lease';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetMeterReading_telematics" BEFORE INSERT ON "AssetMeterReading"
  FOR EACH ROW WHEN (NEW."source" = 'TELEMATICS') EXECUTE FUNCTION public."guardTelematicsMeterReading"();

-- A staff-recorded TELEMATICS reading leaves its transaction as the reading of
-- an ACCEPTED held reading of its event (deferred: the accept writes the
-- reading first, then decides the hold).
CREATE OR REPLACE FUNCTION public."guardTelematicsReadingAccepted"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TelematicsHeldReading" h WHERE h."meterReadingId" = NEW."id" AND h."tenantId" = NEW."tenantId"
      AND h."eventId" = NEW."telematicsEventId" AND h."status" = 'ACCEPTED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A staff-recorded telematics reading is decided as its held reading''s acceptance in the same transaction';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "AssetMeterReading_telematics_accepted" AFTER INSERT ON "AssetMeterReading" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."source" = 'TELEMATICS' AND NEW."recordedById" IS NOT NULL) EXECUTE FUNCTION public."guardTelematicsReadingAccepted"();

-- Created HELD from its METER event (value, unit, SAST date, asset) for a
-- lease of that asset. HELD -> ACCEPTED (the reading its decider recorded from
-- this event) or REJECTED (a note); nothing else changes; never deleted.
CREATE OR REPLACE FUNCTION public."guardTelematicsHeldReading"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  ev RECORD;
  fixed CONSTANT TEXT[] := ARRAY['status', 'decidedById', 'decidedAt', 'decisionNote', 'meterReadingId'];
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A held telematics reading is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e."kind", e."meterValue", e."meterUnit", e."occurredAt", d."assetId" INTO ev
    FROM "TelematicsEvent" e JOIN "TrackerDevice" d ON d."id" = e."deviceId" AND d."tenantId" = e."tenantId"
    WHERE e."id" = NEW."eventId" AND e."tenantId" = NEW."tenantId";
    IF NOT FOUND OR ev."kind" <> 'METER' OR ev."meterValue" <> NEW."value" OR ev."meterUnit" <> NEW."unit"
       OR (ev."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <> NEW."readingDate" OR ev."assetId" <> NEW."assetId"
       OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId" AND l."assetId" = NEW."assetId"
         AND l."contractType"::text IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A held reading is its meter event''s value, unit, SAST date and asset, for a lease of that asset';
    END IF;
    IF NEW."status" <> 'HELD' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A held reading is created HELD';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'HELD' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A decided held reading is final';
  END IF;
  IF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A held reading''s event, lease, date, value and reason are fixed';
  END IF;
  IF NEW."status" = 'ACCEPTED' AND NOT EXISTS (
    SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."meterReadingId" AND m."tenantId" = NEW."tenantId"
      AND m."telematicsEventId" = NEW."eventId" AND m."recordedById" = NEW."decidedById") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An accepted held reading is the reading its decider recorded from its event';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TelematicsHeldReading_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TelematicsHeldReading"
  FOR EACH ROW EXECUTE FUNCTION public."guardTelematicsHeldReading"();
CREATE TRIGGER "TelematicsHeldReading_no_truncate" BEFORE TRUNCATE ON "TelematicsHeldReading"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTelematicsHeldReading"();

-- Raised OPEN, once, at its ALERT event's time, of the event's kind, device and
-- asset, on the running agreement whose tenure covers that time
-- (telematicsLoanAt). A repeat adds one occurrence and never moves the last
-- one back; OPEN -> ACKNOWLEDGED -> RESOLVED (or OPEN -> RESOLVED); resolved
-- is final; the identity and queue are fixed; never deleted.
CREATE OR REPLACE FUNCTION public."guardTelematicsAlert"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  ev RECORD;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics alert is never deleted; it is resolved';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT e."kind", e."alertKind", e."deviceId", e."occurredAt", d."assetId" INTO ev
    FROM "TelematicsEvent" e JOIN "TrackerDevice" d ON d."id" = e."deviceId" AND d."tenantId" = e."tenantId"
    WHERE e."id" = NEW."eventId" AND e."tenantId" = NEW."tenantId";
    IF NOT FOUND OR ev."kind" <> 'ALERT' OR ev."alertKind" <> NEW."kind" OR ev."deviceId" <> NEW."deviceId" OR ev."assetId" <> NEW."assetId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics alert is raised by an alert event of its kind, on its device and asset';
    END IF;
    IF NEW."loanId" IS DISTINCT FROM public."telematicsLoanAt"(NEW."tenantId", ev."assetId", ev."occurredAt") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics alert is raised on the running agreement whose tenure covers its event';
    END IF;
    IF NEW."status" <> 'OPEN' OR NEW."occurrences" <> 1 OR NEW."firstOccurredAt" <> ev."occurredAt" OR NEW."lastOccurredAt" <> ev."occurredAt" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics alert is raised OPEN, once, at its event''s time';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."eventId", NEW."deviceId", NEW."assetId", NEW."loanId", NEW."kind", NEW."queue", NEW."firstOccurredAt", NEW."createdAt")
     IS DISTINCT FROM (OLD."tenantId", OLD."eventId", OLD."deviceId", OLD."assetId", OLD."loanId", OLD."kind", OLD."queue", OLD."firstOccurredAt", OLD."createdAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A telematics alert''s event, device, asset, loan, kind, queue and first occurrence are fixed';
  END IF;
  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A resolved telematics alert is final';
  END IF;
  IF NOT ((NEW."occurrences" = OLD."occurrences" AND NEW."lastOccurredAt" = OLD."lastOccurredAt")
       OR (NEW."occurrences" = OLD."occurrences" + 1 AND NEW."lastOccurredAt" >= OLD."lastOccurredAt")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repeat adds one occurrence and never moves the last occurrence back';
  END IF;
  IF NOT (NEW."status" = OLD."status" OR (OLD."status" = 'OPEN' AND NEW."status" IN ('ACKNOWLEDGED', 'RESOLVED'))
       OR (OLD."status" = 'ACKNOWLEDGED' AND NEW."status" = 'RESOLVED')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A telematics alert cannot move from %s to %s', OLD."status", NEW."status");
  END IF;
  IF OLD."acknowledgedAt" IS NOT NULL AND (NEW."acknowledgedAt", NEW."acknowledgedById") IS DISTINCT FROM (OLD."acknowledgedAt", OLD."acknowledgedById") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An acknowledgement is not changed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TelematicsAlert_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TelematicsAlert"
  FOR EACH ROW EXECUTE FUNCTION public."guardTelematicsAlert"();
CREATE TRIGGER "TelematicsAlert_no_truncate" BEFORE TRUNCATE ON "TelematicsAlert"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTelematicsAlert"();

-- The position access log: insert-only, by a user of the tenant (composite FK),
-- for a loan on the asset and a device of that asset.
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
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "TelematicsPositionAccess_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TelematicsPositionAccess"
  FOR EACH ROW EXECUTE FUNCTION public."guardTelematicsPositionAccess"();
CREATE TRIGGER "TelematicsPositionAccess_no_truncate" BEFORE TRUNCATE ON "TelematicsPositionAccess"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardTelematicsPositionAccess"();

-- Row-level security: the same policy as 20261019120100_dealer_portal on every
-- new model (lib/registry/tenant-scoped-models/250-asset-finance-telematics.ts).
ALTER TABLE "TrackerDevice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrackerDevice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TrackerDevice" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TelematicsEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TelematicsEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TelematicsEvent" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TelematicsPosition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TelematicsPosition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TelematicsPosition" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TelematicsHeldReading" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TelematicsHeldReading" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TelematicsHeldReading" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TelematicsAlert" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TelematicsAlert" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TelematicsAlert" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
ALTER TABLE "TelematicsPositionAccess" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TelematicsPositionAccess" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "TelematicsPositionAccess" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());
