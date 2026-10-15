-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- W4 carry-forward policy (orchestrator decision, 2026-10-14): a review
-- decision is carried onto a re-screen only at the IDENTICAL result level —
-- POSSIBLE → POSSIBLE, or CONFIRMED → CONFIRMED for PEP and adverse media —
-- so an accepted confirmed PEP is not re-referred every cycle. Never upward
-- (a POSSIBLE_MATCH decision never carries onto a CONFIRMED_MATCH), never for
-- SANCTIONS at any level, never without list-entry ids. Mirrors
-- lib/screening/carry.ts; the age and reviewer-role limits live only there.
-- Static reader: lib/screening/screening-migration.test.ts. Behaviour:
-- lib/screening/db-enforcement.integration.test.ts (RUN_SCREENING_IT).
-- Replaces only guardScreeningCheckRecord; schema unchanged.
CREATE OR REPLACE FUNCTION public."guardScreeningCheckRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Screening checks cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."subjectFingerprint" IS NULL OR btrim(NEW."subjectFingerprint") = '' THEN
      RAISE EXCEPTION 'A screening check names the identity it screened'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_subject_fingerprint';
    END IF;
    IF NEW.decision IS NOT NULL AND NOT (
      NEW.result IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH')
      AND NEW.type <> 'SANCTIONS'
      AND NEW.decision IN ('FALSE_POSITIVE', 'ACCEPTED')
      AND jsonb_typeof(NEW.matches) = 'array'
      AND jsonb_array_length(NEW.matches) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.matches) m
        WHERE coalesce(btrim(m->>'listEntryId'), '') = ''
      )
      AND EXISTS (
        SELECT 1 FROM "ScreeningCheck" p
        WHERE p.id = NEW."carriedFromCheckId"
          AND p."tenantId" = NEW."tenantId"
          AND p."clientId" IS NOT DISTINCT FROM NEW."clientId"
          AND p."entityId" IS NOT DISTINCT FROM NEW."entityId"
          AND p.type = NEW.type
          AND p.result = NEW.result
          AND p."matchFingerprint" = NEW."matchFingerprint"
          AND p.decision = NEW.decision
      )
    ) THEN
      RAISE EXCEPTION 'A screening check is born undecided unless it carries an earlier identical clearance at the same result level'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_born_undecided';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Screening check % is decided and cannot change', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_decided_immutable';
  END IF;
  IF (NEW.id, NEW."tenantId", NEW."clientId", NEW."entityId", NEW."subjectFingerprint", NEW."triggeredById",
      NEW."runId", NEW.trigger, NEW."applicationId", NEW.provider, NEW.type, NEW.result, NEW.matches,
      NEW."matchFingerprint", NEW."providerReference", NEW."errorCode", NEW.simulated, NEW."carriedFromCheckId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."tenantId", OLD."clientId", OLD."entityId", OLD."subjectFingerprint", OLD."triggeredById",
      OLD."runId", OLD.trigger, OLD."applicationId", OLD.provider, OLD.type, OLD.result, OLD.matches,
      OLD."matchFingerprint", OLD."providerReference", OLD."errorCode", OLD.simulated, OLD."carriedFromCheckId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Screening check % may only receive its review decision', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_transition';
  END IF;
  RETURN NEW;
END;
$function$;
