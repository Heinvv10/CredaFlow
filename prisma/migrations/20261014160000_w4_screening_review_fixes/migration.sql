-- CreateEnum
CREATE TYPE "ScreeningBlockReason" AS ENUM ('SANCTIONS_MATCH', 'REJECTED');

-- AlterTable
ALTER TABLE "ScreeningCheck" ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "subjectFingerprint" TEXT,
ADD COLUMN     "triggeredById" TEXT,
ALTER COLUMN "clientId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ScreeningBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT,
    "entityId" TEXT,
    "sourceCheckId" TEXT NOT NULL,
    "reason" "ScreeningBlockReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liftedById" TEXT,
    "liftedAt" TIMESTAMP(3),
    "liftReason" TEXT,

    CONSTRAINT "ScreeningBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScreeningBlock_sourceCheckId_key" ON "ScreeningBlock"("sourceCheckId");

-- CreateIndex
CREATE INDEX "ScreeningBlock_tenantId_clientId_idx" ON "ScreeningBlock"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "ScreeningBlock_tenantId_entityId_idx" ON "ScreeningBlock"("tenantId", "entityId");

-- CreateIndex
CREATE INDEX "ScreeningCheck_tenantId_entityId_createdAt_idx" ON "ScreeningCheck"("tenantId", "entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_tenantId_entityId_fkey" FOREIGN KEY ("tenantId", "entityId") REFERENCES "BusinessEntity"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_tenantId_sourceCheckId_fkey" FOREIGN KEY ("tenantId", "sourceCheckId") REFERENCES "ScreeningCheck"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- Round-1 review fixes for W4 (PR #81). Static readers:
-- lib/screening/screening-migration.test.ts. Behaviour: RUN_SCREENING_IT suites.

-- A run screens exactly one subject: a client or a business entity.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_one_subject" CHECK (
  ("clientId" IS NULL) <> ("entityId" IS NULL)
);

-- Maker-checker: whoever started a run never decides its matches.
ALTER TABLE "ScreeningCheck" ADD CONSTRAINT "ScreeningCheck_maker_checker" CHECK (
  "reviewedById" IS NULL OR "triggeredById" IS NULL OR "reviewedById" <> "triggeredById"
);

-- The identity a run screened, as one hash. The application reads it through
-- screeningCurrentFingerprint() before calling the provider, so TypeScript
-- and the approval trigger never compute it two ways.
CREATE OR REPLACE FUNCTION public."screeningPersonFingerprint"(first_name text, last_name text, id_number text, date_of_birth timestamp without time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT encode(sha256(convert_to(concat_ws('|', 'PERSON',
    regexp_replace(btrim(first_name), '\s+', ' ', 'g'),
    regexp_replace(btrim(last_name), '\s+', ' ', 'g'),
    upper(regexp_replace(id_number, '\s', '', 'g')),
    coalesce(to_char(date_of_birth, 'YYYY-MM-DD'), '')), 'UTF8')), 'hex')
$function$;

CREATE OR REPLACE FUNCTION public."screeningEntityFingerprint"(entity_type text, legal_name text, registration_number text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT encode(sha256(convert_to(concat_ws('|', 'ENTITY', entity_type,
    regexp_replace(btrim(legal_name), '\s+', ' ', 'g'),
    upper(regexp_replace(registration_number, '\s', '', 'g'))), 'UTF8')), 'hex')
$function$;

CREATE OR REPLACE FUNCTION public."screeningCurrentFingerprint"(t text, cid text, eid text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN cid IS NOT NULL THEN (
      SELECT "screeningPersonFingerprint"(c."firstName", c."lastName", c."idNumber", c."dateOfBirth")
      FROM "Client" c WHERE c.id = cid AND c."tenantId" = t)
    ELSE (
      SELECT "screeningEntityFingerprint"(e.type::text, e."legalName", e."registrationNumber")
      FROM "BusinessEntity" e WHERE e.id = eid AND e."tenantId" = t)
  END
$function$;

-- The record guard, replaced. New on INSERT: a run names the identity it
-- screened; a decision is carried only onto a POSSIBLE_MATCH, from a
-- POSSIBLE_MATCH of the same subject, type and fingerprint decided
-- FALSE_POSITIVE or ACCEPTED, and only when every match has a list-entry id.
-- New on UPDATE: subject, fingerprint and trigger user are immutable too.
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
      NEW.result = 'POSSIBLE_MATCH'
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
          AND p.result = 'POSSIBLE_MATCH'
          AND p."matchFingerprint" = NEW."matchFingerprint"
          AND p.decision = NEW.decision
      )
    ) THEN
      RAISE EXCEPTION 'A screening check is born undecided unless it carries an earlier identical clearance of a possible match'
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

-- Sticky blocks: written HERE, by the database, for any writer. A confirmed
-- sanctions match blocks from the moment it is recorded; a REJECTED decision
-- from the moment it is made. A later clear run does not lift either.
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
  INSERT INTO "ScreeningBlock" ("id", "tenantId", "clientId", "entityId", "sourceCheckId", "reason")
  VALUES ('sb_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."clientId", NEW."entityId", NEW.id, block_reason);
  RETURN NULL;
END;
$function$;

CREATE TRIGGER "ScreeningCheck_record_block" AFTER INSERT OR UPDATE OF decision ON "ScreeningCheck" FOR EACH ROW EXECUTE FUNCTION "recordScreeningBlock"();

ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_one_subject" CHECK (
  ("clientId" IS NULL) <> ("entityId" IS NULL)
);

-- Lifted whole (who, when, why: 15+ characters) or not at all.
ALTER TABLE "ScreeningBlock" ADD CONSTRAINT "ScreeningBlock_lift_complete" CHECK (
  ("liftedById" IS NULL AND "liftedAt" IS NULL AND "liftReason" IS NULL)
  OR ("liftedById" IS NOT NULL AND "liftedAt" IS NOT NULL AND char_length(btrim(coalesce("liftReason", ''))) >= 15)
);

-- A block is born unlifted from the check that caused it; never deleted; its
-- identity never changes; it is lifted once, by an active SUPER_ADMIN of the
-- tenant, and never re-imposed or edited afterwards.
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
        AND ((NEW.reason = 'SANCTIONS_MATCH' AND s.type = 'SANCTIONS' AND s.result = 'CONFIRMED_MATCH')
          OR (NEW.reason = 'REJECTED' AND s.decision = 'REJECTED'))
    ) THEN
      RAISE EXCEPTION 'A screening block is born unlifted from the check that caused it'
        USING ERRCODE = '23514', CONSTRAINT = 'ScreeningBlock_born_from_check';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."liftedAt" IS NOT NULL
     OR (NEW.id, NEW."tenantId", NEW."clientId", NEW."entityId", NEW."sourceCheckId", NEW.reason, NEW."createdAt")
        IS DISTINCT FROM (OLD.id, OLD."tenantId", OLD."clientId", OLD."entityId", OLD."sourceCheckId", OLD.reason, OLD."createdAt") THEN
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

CREATE TRIGGER "ScreeningBlock_guard_record" BEFORE INSERT OR UPDATE OR DELETE ON "ScreeningBlock" FOR EACH ROW EXECUTE FUNCTION "guardScreeningBlock"();
CREATE TRIGGER "ScreeningBlock_guard_truncate" BEFORE TRUNCATE ON "ScreeningBlock" FOR EACH STATEMENT EXECUTE FUNCTION "guardScreeningBlock"();

-- Why one subject (client or entity) may not be approved, or NULL. The same
-- rule as lib/screening/state.ts: an unlifted block; no run; a latest run of
-- a different identity; an errored type; an undecided or REJECTED match.
CREATE OR REPLACE FUNCTION public."screeningSubjectRefusal"(t text, cid text, eid text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  latest_run TEXT;
  latest_fp TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ScreeningBlock" b
    WHERE b."tenantId" = t AND b."liftedAt" IS NULL
      AND ((cid IS NOT NULL AND b."clientId" = cid) OR (cid IS NULL AND b."entityId" = eid))
  ) THEN
    RETURN 'blocks';
  END IF;
  IF cid IS NOT NULL THEN
    SELECT s."runId", s."subjectFingerprint" INTO latest_run, latest_fp FROM "ScreeningCheck" s
     WHERE s."tenantId" = t AND s."clientId" = cid ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1;
  ELSE
    SELECT s."runId", s."subjectFingerprint" INTO latest_run, latest_fp FROM "ScreeningCheck" s
     WHERE s."tenantId" = t AND s."entityId" = eid ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1;
  END IF;
  IF latest_run IS NULL OR latest_fp IS DISTINCT FROM "screeningCurrentFingerprint"(t, cid, eid) THEN
    RETURN 'required';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ScreeningCheck" s
     WHERE s."tenantId" = t AND s."runId" = latest_run
       AND (s.result = 'ERROR'
            OR (s.result IN ('POSSIBLE_MATCH', 'CONFIRMED_MATCH') AND (s.decision IS NULL OR s.decision = 'REJECTED')))
  ) THEN
    RETURN 'blocks';
  END IF;
  RETURN NULL;
END;
$function$;

-- The approval guard, replaced: a client borrower as before (now identity-bound
-- and sticky), and an entity borrower: the entity itself and every person
-- actively related to it (directors, members, trustees, signatories, sureties,
-- beneficial owners). Still a no-op for a tenant without a provider.
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

-- A changed identity makes a CLEARED client PENDING at once, for every writer.
-- The gate also sees the fingerprint mismatch and re-screens.
CREATE OR REPLACE FUNCTION public."markScreeningStaleOnIdentityChange"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."firstName", NEW."lastName", NEW."idNumber", NEW."dateOfBirth")
       IS DISTINCT FROM (OLD."firstName", OLD."lastName", OLD."idNumber", OLD."dateOfBirth")
     AND NEW."amlScreeningStatus" = 'CLEARED' THEN
    NEW."amlScreeningStatus" := 'PENDING';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Client_screening_stale_on_identity_change" BEFORE UPDATE OF "firstName", "lastName", "idNumber", "dateOfBirth" ON "Client" FOR EACH ROW EXECUTE FUNCTION "markScreeningStaleOnIdentityChange"();

-- Maker-checker on the FIC registers: the raiser never decides the STR case;
-- the uploader never approves the RMCP version.
ALTER TABLE "SuspiciousReportCase" ADD CONSTRAINT "SuspiciousReportCase_maker_checker" CHECK (
  "assessedById" IS NULL OR "assessedById" <> "raisedById"
);
ALTER TABLE "RmcpDocument" ADD CONSTRAINT "RmcpDocument_maker_checker" CHECK (
  "approvedById" IS NULL OR "approvedById" <> "uploadedById"
);
