-- Reference rates fetched from the SARB public feed (lib/asset-finance/rate-feed-sync.ts).
--
-- ENFORCEMENT-ADDING: the source / requester CHECK and the immutable `source`
-- take effect at once, so this migration ships with the code that writes
-- them. The manual path (app/api/asset-finance/reference-rates) sets no
-- source, so its rows take the MANUAL default and keep a requester.
--
-- A fetched value has no human requester: it is recorded PENDING by the feed
-- (source SARB_FEED, requestedById NULL) and a user decides it exactly as
-- they decide a manual one. The two-person rule is unchanged: nothing is
-- APPROVED on insert (ReferenceRate_born_pending), and the decider is a user.
--
-- Existing rows: every one was recorded by a user, so every one is MANUAL with
-- a requester and passes the new CHECK.

CREATE TYPE "ReferenceRateSource" AS ENUM ('MANUAL', 'SARB_FEED');

ALTER TABLE "ReferenceRate" ADD COLUMN "source" "ReferenceRateSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "ReferenceRate" ALTER COLUMN "requestedById" DROP NOT NULL;

-- A user records a MANUAL value and only a MANUAL value has a requester. The
-- composite FK (tenantId, requestedById) is MATCH SIMPLE, so a NULL requester
-- skips it; this CHECK is what confines a NULL requester to SARB_FEED rows.
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_requester_source" CHECK (("source" = 'MANUAL') = ("requestedById" IS NOT NULL));

-- The decider is never the requester. The old form, "decidedById" IS DISTINCT
-- FROM "requestedById", is false for a PENDING feed row (NULL against NULL),
-- so an undecided row passes explicitly. A decided row is unchanged: a user
-- is distinct from the requester, and from a NULL one.
ALTER TABLE "ReferenceRate" DROP CONSTRAINT "ReferenceRate_four_eyes";
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_four_eyes" CHECK ("decidedById" IS NULL OR "decidedById" IS DISTINCT FROM "requestedById");

-- guardReferenceRateLifecycle, with `source` among the columns that never
-- change. Otherwise unchanged from 20261013100000.
CREATE OR REPLACE FUNCTION public."guardReferenceRateLifecycle"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ReferenceRate rows are never truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approved reference rate is never deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."basis" IS DISTINCT FROM OLD."basis"
     OR NEW."effectiveDate" IS DISTINCT FROM OLD."effectiveDate"
     OR NEW."rate" IS DISTINCT FROM OLD."rate"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A reference rate''s value, basis, date, tenant, source and requester never change';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s reference rate is immutable', OLD."status");
  END IF;
  IF NEW."status" <> 'PENDING' THEN
    NEW."decidedAt" := clock_timestamp() AT TIME ZONE 'UTC';
  END IF;
  RETURN NEW;
END;
$function$;
