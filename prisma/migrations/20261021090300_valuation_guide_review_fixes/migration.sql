-- Valuation guides, review round 1 (docs/asset-finance/SLICE5.md part C).
-- Hand-written, additive: two CHECKs, and guardValuationGuide and
-- checkValuationGuideSuccessor replaced.
--
-- 1. The database dates every move itself: uploadedAt on insert, publishedAt,
--    discardedAt and supersededAt on the move (a caller's value is replaced).
--    clock_timestamp(), not now(): now() is the transaction's start, so a
--    publish whose transaction began before a rival publish of that name
--    committed would date its supersede before the rival's publish.
--    ValuationGuide_times keeps the times in order behind the trigger.
-- 2. A guide is superseded only by another guide of the same name, dated on
--    or after it, that is a DRAFT about to be published in the same
--    transaction; at commit that successor is PUBLISHED. No self-supersede,
--    no cycle, and no supersede leaves a name without a current guide.
-- 3. A synthetic-provider guide is always stored simulated.
-- Tests: lib/valuation-guides/guide-gaps.integration.test.ts,
-- guide-breaker.integration.test.ts, guide-rules.integration.test.ts.

ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_synthetic_simulated" CHECK ("provider" <> 'synthetic' OR "simulated");
ALTER TABLE "ValuationGuide" ADD CONSTRAINT "ValuationGuide_times" CHECK (
  ("publishedAt" IS NULL OR "publishedAt" >= "uploadedAt")
  AND ("supersededAt" IS NULL OR "supersededAt" >= "publishedAt")
  AND ("discardedAt" IS NULL OR "discardedAt" >= "uploadedAt")
);

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
    NEW."uploadedAt" := clock_timestamp();
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
    NEW."publishedAt" := clock_timestamp();
    IF NEW."effectiveOn" > today THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is published on or after its effective date';
    END IF;
    IF (SELECT count(*) FROM "ValuationGuideRow" r WHERE r."tenantId" = NEW."tenantId" AND r."guideId" = NEW."id") <> NEW."rowCount" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is published with every row it was loaded with';
    END IF;
  ELSIF OLD."status" = 'DRAFT' AND NEW."status" = 'DISCARDED' THEN
    NEW."discardedAt" := clock_timestamp();
  ELSIF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED' THEN
    NEW."supersededAt" := clock_timestamp();
    IF NOT EXISTS (SELECT 1 FROM "ValuationGuide" g WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."supersededById" AND g."id" <> NEW."id"
        AND g."status" = 'DRAFT' AND lower(g."name") = lower(NEW."name") AND g."effectiveOn" >= NEW."effectiveOn") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A guide is superseded by another guide of the same name dated on or after it, a draft put live in the same transaction';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- At commit, the successor a guide was superseded by is the current guide.
CREATE OR REPLACE FUNCTION public."checkValuationGuideSuccessor"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'SUPERSEDED' AND NOT EXISTS (SELECT 1 FROM "ValuationGuide" g
      WHERE g."tenantId" = NEW."tenantId" AND g."id" = NEW."supersededById" AND g."status" = 'PUBLISHED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A superseded guide''s successor is published by the end of its transaction';
  END IF;
  RETURN NULL;
END;
$function$;
