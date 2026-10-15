-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- W4 segregation of duties at approval, second half (after 1f143b40). With
-- TenantConfig.requireSecondReviewer on, the user who decided any match the
-- borrower's current screening relies on — in the latest run of the client,
-- or of the entity and its active related people, following carried
-- decisions back to the original human decider — cannot approve the
-- application. Schema unchanged. Static reader:
-- lib/screening/screening-migration.test.ts. Behaviour:
-- lib/screening/breaker-repros-round4.integration.test.ts (RUN_SCREENING_IT).

-- Did `uid` make a decision the subject's latest run relies on? Decided rows
-- of the latest run, and every check their carried decisions descend from.
CREATE OR REPLACE FUNCTION public."screeningDecidedBy"(t text, cid text, eid text, uid text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  latest_run TEXT;
BEGIN
  IF cid IS NOT NULL THEN
    SELECT s."runId" INTO latest_run FROM "ScreeningCheck" s
     WHERE s."tenantId" = t AND s."clientId" = cid ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1;
  ELSE
    SELECT s."runId" INTO latest_run FROM "ScreeningCheck" s
     WHERE s."tenantId" = t AND s."entityId" = eid ORDER BY s."createdAt" DESC, s.id DESC LIMIT 1;
  END IF;
  IF latest_run IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    WITH RECURSIVE chain AS (
      SELECT s.id, s."reviewedById", s."carriedFromCheckId" FROM "ScreeningCheck" s
       WHERE s."tenantId" = t AND s."runId" = latest_run AND s.decision IS NOT NULL
      UNION
      SELECT p.id, p."reviewedById", p."carriedFromCheckId" FROM "ScreeningCheck" p
        JOIN chain c ON p.id = c."carriedFromCheckId" AND p."tenantId" = t
    )
    SELECT 1 FROM chain WHERE chain."reviewedById" = uid
  );
END;
$function$;

-- The same over a borrower: the client, or the entity and its active related people.
CREATE OR REPLACE FUNCTION public."screeningApproverDecided"(t text, cid text, eid text, uid text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE
    WHEN cid IS NOT NULL THEN "screeningDecidedBy"(t, cid, NULL, uid)
    WHEN eid IS NOT NULL THEN "screeningDecidedBy"(t, NULL, eid, uid) OR EXISTS (
      SELECT 1 FROM "EntityRelationship" r
       WHERE r."tenantId" = t AND r."entityId" = eid AND r.active AND "screeningDecidedBy"(t, r."clientId", NULL, uid))
    ELSE false
  END
$function$;

-- The approval guard, replaced: as before, plus the segregation-of-duties refusal.
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
  -- Segregation of duties: with a second reviewer required, whoever decided a
  -- match the screening relies on does not approve. APPROVED only; the
  -- approver is NEW."approvedById" (set by every approval path).
  IF NEW.status = 'APPROVED' AND NEW."approvedById" IS NOT NULL
     AND coalesce((SELECT c."requireSecondReviewer" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), true)
     AND "screeningApproverDecided"(NEW."tenantId", NEW."clientId", NEW."entityId", NEW."approvedById") THEN
    RAISE EXCEPTION 'Application % cannot be approved by %: the approver decided a screening match it relies on', NEW.id, NEW."approvedById"
      USING ERRCODE = '23514', CONSTRAINT = 'LoanApplication_screening_self_decided';
  END IF;
  RETURN NEW;
END;
$function$;
