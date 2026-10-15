-- AlterTable
ALTER TABLE "ScreeningBlock" ADD COLUMN     "contextEntityId" TEXT;

-- AlterTable
ALTER TABLE "ScreeningCheck" ADD COLUMN     "contextEntityId" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "requireSecondReviewer" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "ScreeningBlock_tenantId_contextEntityId_idx" ON "ScreeningBlock"("tenantId", "contextEntityId");


-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- W4 round-2 review fixes (PR #81 at 885c5531). Static reader:
-- lib/screening/screening-migration.test.ts. Behaviour: RUN_SCREENING_IT suites
-- (breaker-repros-round2, db-enforcement-round2).

-- N1: each fingerprint field is length-prefixed, so no character in a name
-- ('|' included) can make two identities hash alike. NULL is '~', distinct
-- from every length-prefixed value. Every stored fingerprint changes with this
-- migration: existing runs read as NOT_SCREENED and are re-screened.
CREATE OR REPLACE FUNCTION public."screeningFingerprintField"(v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN v IS NULL THEN '~' ELSE char_length(v)::text || ':' || v END
$function$;

CREATE OR REPLACE FUNCTION public."screeningPersonFingerprint"(first_name text, last_name text, id_number text, date_of_birth timestamp without time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT encode(sha256(convert_to(concat_ws('|', 'PERSON',
    "screeningFingerprintField"(regexp_replace(btrim(first_name), '\s+', ' ', 'g')),
    "screeningFingerprintField"(regexp_replace(btrim(last_name), '\s+', ' ', 'g')),
    "screeningFingerprintField"(upper(regexp_replace(id_number, '\s', '', 'g'))),
    "screeningFingerprintField"(to_char(date_of_birth, 'YYYY-MM-DD'))), 'UTF8')), 'hex')
$function$;

CREATE OR REPLACE FUNCTION public."screeningEntityFingerprint"(entity_type text, legal_name text, registration_number text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT encode(sha256(convert_to(concat_ws('|', 'ENTITY',
    "screeningFingerprintField"(entity_type),
    "screeningFingerprintField"(regexp_replace(btrim(legal_name), '\s+', ' ', 'g')),
    "screeningFingerprintField"(upper(regexp_replace(registration_number, '\s', '', 'g')))), 'UTF8')), 'hex')
$function$;

-- N6: an identity change is a change of the identity fingerprint, under the
-- same normalisation; whitespace-only edits keep the client CLEARED.
CREATE OR REPLACE FUNCTION public."markScreeningStaleOnIdentityChange"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."amlScreeningStatus" = 'CLEARED'
     AND "screeningPersonFingerprint"(NEW."firstName", NEW."lastName", NEW."idNumber", NEW."dateOfBirth")
         IS DISTINCT FROM "screeningPersonFingerprint"(OLD."firstName", OLD."lastName", OLD."idNumber", OLD."dateOfBirth") THEN
    NEW."amlScreeningStatus" := 'PENDING';
  END IF;
  RETURN NEW;
END;
$function$;

-- The record guard, replaced. N2: a decision is carried only from a check of
-- the SAME screened identity (subjectFingerprint). contextEntityId is
-- immutable like the rest of the record. Carry otherwise as the carry-policy
-- migration: same result level, never sanctions, list-entry ids required.
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
          AND p."subjectFingerprint" = NEW."subjectFingerprint"
          AND p.type = NEW.type
          AND p.result = NEW.result
          AND p."matchFingerprint" = NEW."matchFingerprint"
          AND p.decision = NEW.decision
      )
    ) THEN
      RAISE EXCEPTION 'A screening check is born undecided unless it carries an earlier identical clearance of the same identity at the same result level'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_born_undecided';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.decision IS NOT NULL THEN
    RAISE EXCEPTION 'Screening check % is decided and cannot change', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_decided_immutable';
  END IF;
  IF (NEW.id, NEW."tenantId", NEW."clientId", NEW."entityId", NEW."subjectFingerprint", NEW."triggeredById", NEW."contextEntityId",
      NEW."runId", NEW.trigger, NEW."applicationId", NEW.provider, NEW.type, NEW.result, NEW.matches,
      NEW."matchFingerprint", NEW."providerReference", NEW."errorCode", NEW.simulated, NEW."carriedFromCheckId", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."tenantId", OLD."clientId", OLD."entityId", OLD."subjectFingerprint", OLD."triggeredById", OLD."contextEntityId",
      OLD."runId", OLD.trigger, OLD."applicationId", OLD.provider, OLD.type, OLD.result, OLD.matches,
      OLD."matchFingerprint", OLD."providerReference", OLD."errorCode", OLD.simulated, OLD."carriedFromCheckId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Screening check % may only receive its review decision', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_transition';
  END IF;
  RETURN NEW;
END;
$function$;

-- Blocks carry the entity a person was screened for.
CREATE OR REPLACE FUNCTION public."recordScreeningBlock"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  block_reason "ScreeningBlockReason";
BEGIN
  IF TG_OP = 'INSERT' AND NEW.type = 'SANCTIONS' AND NEW.result = 'CONFIRMED_MATCH' THEN
    block_reason := 'SANCTIONS_MATCH';
  ELSIF NEW.decision = 'REJECTED' AND (TG_OP = 'INSERT' OR OLD.decision IS NULL) THEN
    block_reason := 'REJECTED';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO "ScreeningBlock" ("id", "tenantId", "clientId", "entityId", "contextEntityId", "sourceCheckId", "reason")
  VALUES ('sb_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."clientId", NEW."entityId",
          NEW."contextEntityId", NEW.id, block_reason);
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardScreeningBlock"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Screening blocks cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningBlock_no_delete';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."liftedAt" IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM "ScreeningCheck" s
      WHERE s.id = NEW."sourceCheckId" AND s."tenantId" = NEW."tenantId"
        AND s."clientId" IS NOT DISTINCT FROM NEW."clientId"
        AND s."entityId" IS NOT DISTINCT FROM NEW."entityId"
        AND s."contextEntityId" IS NOT DISTINCT FROM NEW."contextEntityId"
        AND ((NEW.reason = 'SANCTIONS_MATCH' AND s.type = 'SANCTIONS' AND s.result = 'CONFIRMED_MATCH')
          OR (NEW.reason = 'REJECTED' AND s.decision = 'REJECTED'))
    ) THEN
      RAISE EXCEPTION 'A screening block is born unlifted from the check that caused it'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningBlock_born_from_check';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."liftedAt" IS NOT NULL
     OR (NEW.id, NEW."tenantId", NEW."clientId", NEW."entityId", NEW."contextEntityId", NEW."sourceCheckId", NEW.reason, NEW."createdAt")
        IS DISTINCT FROM (OLD.id, OLD."tenantId", OLD."clientId", OLD."entityId", OLD."contextEntityId", OLD."sourceCheckId", OLD.reason, OLD."createdAt") THEN
    RAISE EXCEPTION 'Screening block % may only be lifted, once', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningBlock_transition';
  END IF;
  IF NEW."liftedById" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = NEW."liftedById" AND u."tenantId" = NEW."tenantId" AND u.role = 'SUPER_ADMIN' AND u.active
  ) THEN
    RAISE EXCEPTION 'Only an active SUPER_ADMIN of the lender lifts a screening block'
      USING ERRCODE = '23514', CONSTRAINT = 'ScreeningBlock_lift_requires_super_admin';
  END IF;
  RETURN NEW;
END;
$function$;

-- N7: an unlifted block on a person screened for this entity, or on anyone
-- with any relationship row to it (active or not), blocks the entity. A
-- relationship deactivated or deleted after a sanctions hit frees nothing.
CREATE OR REPLACE FUNCTION public."screeningEntityContextBlocked"(t text, eid text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM "ScreeningBlock" b
     WHERE b."tenantId" = t AND b."liftedAt" IS NULL
       AND (b."contextEntityId" = eid
            OR b."clientId" IN (SELECT r."clientId" FROM "EntityRelationship" r WHERE r."tenantId" = t AND r."entityId" = eid))
  )
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationScreening"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  configured TEXT;
  refusal TEXT;
  related RECORD;
BEGIN
  IF NEW.status NOT IN ('APPROVED', 'DISBURSED')
     OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NEW;
  END IF;
  SELECT c."screeningProvider" INTO configured FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
  IF configured IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."clientId" IS NOT NULL THEN
    refusal := "screeningSubjectRefusal"(NEW."tenantId", NEW."clientId", NULL);
  ELSIF NEW."entityId" IS NOT NULL THEN
    refusal := "screeningSubjectRefusal"(NEW."tenantId", NULL, NEW."entityId");
    IF refusal IS NULL AND "screeningEntityContextBlocked"(NEW."tenantId", NEW."entityId") THEN
      refusal := 'blocks';
    END IF;
    IF refusal IS NULL THEN
      FOR related IN
        SELECT DISTINCT r."clientId" FROM "EntityRelationship" r
         WHERE r."tenantId" = NEW."tenantId" AND r."entityId" = NEW."entityId" AND r.active
         ORDER BY r."clientId"
      LOOP
        refusal := "screeningSubjectRefusal"(NEW."tenantId", related."clientId", NULL);
        EXIT WHEN refusal IS NOT NULL;
      END LOOP;
    END IF;
  ELSE
    refusal := 'required';
  END IF;
  IF refusal = 'required' THEN
    RAISE EXCEPTION 'Application % cannot be approved: its borrower has not been screened', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_screening_required';
  ELSIF refusal = 'blocks' THEN
    RAISE EXCEPTION 'Application % cannot be approved: its borrower''s screening blocks approval', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_screening_blocks_approval';
  END IF;
  RETURN NEW;
END;
$function$;

-- Maker-checker becomes a per-lender setting (TenantConfig.requireSecondReviewer,
-- default on; a missing row counts as on). The CHECKs are replaced by one
-- trigger that reads it; the constraint names in its errors are unchanged.
ALTER TABLE "ScreeningCheck" DROP CONSTRAINT "ScreeningCheck_maker_checker";
ALTER TABLE "SuspiciousReportCase" DROP CONSTRAINT "SuspiciousReportCase_maker_checker";
ALTER TABLE "RmcpDocument" DROP CONSTRAINT "RmcpDocument_maker_checker";

CREATE OR REPLACE FUNCTION public."enforceSecondReviewer"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT coalesce((SELECT c."requireSecondReviewer" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), true) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'ScreeningCheck' THEN
    IF NEW."reviewedById" IS NOT NULL AND NEW."reviewedById" = NEW."triggeredById" THEN
      RAISE EXCEPTION 'The user who started a screening run does not decide its matches'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningCheck_maker_checker';
    END IF;
  ELSIF TG_TABLE_NAME = 'SuspiciousReportCase' THEN
    IF NEW."assessedById" IS NOT NULL AND NEW."assessedById" = NEW."raisedById" THEN
      RAISE EXCEPTION 'The user who raised an STR case does not decide it'
        USING ERRCODE = '23514', CONSTRAINT = 'SuspiciousReportCase_maker_checker';
    END IF;
  ELSIF TG_TABLE_NAME = 'RmcpDocument' THEN
    IF NEW."approvedById" IS NOT NULL AND NEW."approvedById" = NEW."uploadedById" THEN
      RAISE EXCEPTION 'The user who uploaded an RMCP version does not approve it'
        USING ERRCODE = '23514', CONSTRAINT = 'RmcpDocument_maker_checker';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ScreeningCheck_second_reviewer" BEFORE UPDATE ON "ScreeningCheck" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
CREATE TRIGGER "SuspiciousReportCase_second_reviewer" BEFORE UPDATE ON "SuspiciousReportCase" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
CREATE TRIGGER "RmcpDocument_second_reviewer" BEFORE UPDATE ON "RmcpDocument" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
