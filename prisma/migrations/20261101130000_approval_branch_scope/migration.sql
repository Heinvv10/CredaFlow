-- F8: a matrix level can be branch-scoped (levelsSnapshot[].branchScoped, written by lib/approval/matrix-payload.ts). The step trigger holds it.
-- A step: on an open case, in order, by an active person who is not the system user and did not capture the application
-- or change its inputs (the maker is never the approver). One person approves once per case, one approval per level.
-- A delegated step names a real delegation of that approver, in its window, unrevoked, reaching the level and the amount; and
-- one person never holds two seats: the delegator neither captured the application nor approved it, directly or through a delegate.
CREATE OR REPLACE FUNCTION public."guardApprovalStep"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  c RECORD;
  done INTEGER;
  dg RECORD;
  amount BIGINT;
  principals TEXT[];
  seat TEXT;
  level_role TEXT;
  committee_level INTEGER;
  latest TEXT;
  branch_scoped BOOLEAN;
  holder_branch TEXT;
  holder_role TEXT;
  application_branch TEXT;
BEGIN
  SELECT * INTO c FROM "ApprovalCase" WHERE "id" = NEW."caseId" AND "tenantId" = NEW."tenantId";
  IF NOT FOUND OR c."status" <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded only on an open approval case';
  END IF;
  IF c."applicationId" IS DISTINCT FROM NEW."applicationId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval step names its case''s application';
  END IF;
  IF c."requiredLevels" IS NULL OR NEW."level" > c."requiredLevels" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded only at a level the case requires';
  END IF;
  SELECT count(*) INTO done FROM "ApprovalStep" WHERE "caseId" = NEW."caseId";
  IF NEW."level" <> done + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Approvals are recorded in order, one level after another';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."approverId" AND u."tenantId" = NEW."tenantId" AND u."active" AND NOT u."isSystem") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval is recorded against an active staff member, never the automated decisioning account';
  END IF;
  principals := ARRAY[NEW."approverId"];
  IF NEW."via" = 'DELEGATION' THEN
    SELECT * INTO dg FROM "ApprovalDelegation" d WHERE d."id" = NEW."delegationId" AND d."tenantId" = NEW."tenantId";
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A delegated approval names a delegation that exists';
    END IF;
    SELECT a."appliedAmount" INTO amount FROM "LoanApplication" a WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId";
    IF dg."delegateId" <> NEW."approverId" OR dg."level" < NEW."level" OR dg."validFrom" > now() OR dg."validTo" < now()
      OR (dg."revokedAt" IS NOT NULL AND dg."revokedAt" <= now()) OR amount > dg."maxAmountCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A delegated approval names a delegation to the approver that is in force and reaches this level and amount';
    END IF;
    principals := principals || dg."delegatorId";
  END IF;
  seat := public."approvalSeatTaken"(NEW."caseId", NEW."tenantId", NEW."applicationId", principals, NULL);
  IF seat = 'MAKER' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Maker-checker: the staff member who captured the application or changed its inputs cannot approve it';
  ELSIF seat = 'RECORDED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: whoever recorded the credit committee''s decision, or whose authority it was recorded on, cannot give the committee level''s approval';
  ELSIF seat IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: one person holds one seat on an application: an approver, or the authority a delegate acted on, appears once';
  END IF;
  -- An approval by role is recorded only by someone whose role reaches the level (a delegation's reach is checked above).
  IF NEW."via" = 'ROLE' THEN
    SELECT l->>'role' INTO level_role FROM jsonb_array_elements(c."levelsSnapshot") l WHERE (l->>'level')::int = NEW."level";
    IF public."approvalRoleRank"((SELECT u."role"::text FROM "User" u WHERE u."id" = NEW."approverId" AND u."tenantId" = NEW."tenantId")) < GREATEST(1, public."approvalRoleRank"(level_role)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approval by role is recorded only by someone whose role reaches the level';
    END IF;
  END IF;
  -- A branch-scoped level is held at one's own branch: the approver's, or the delegator's on a delegated step. With no branch, only head
  -- office holds it (an ADMIN or SUPER_ADMIN, for every branch); anyone else with no branch holds it nowhere.
  SELECT (l->>'branchScoped')::boolean INTO branch_scoped FROM jsonb_array_elements(c."levelsSnapshot") l WHERE (l->>'level')::int = NEW."level";
  IF branch_scoped THEN
    SELECT u."branchId", u."role"::text INTO holder_branch, holder_role FROM "User" u WHERE u."tenantId" = NEW."tenantId" AND u."id" = principals[array_length(principals, 1)];
    SELECT a."branchId" INTO application_branch FROM "LoanApplication" a WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId";
    IF NOT (CASE WHEN holder_branch IS NULL THEN public."approvalRoleRank"(holder_role) >= public."approvalRoleRank"('ADMIN') ELSE holder_branch IS NOT DISTINCT FROM application_branch END) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A branch-scoped level is approved only with authority held at the application''s branch';
    END IF;
  END IF;
  -- The committee's level (and any after it) is approved only while the committee's latest decision is an approval.
  SELECT (l->>'level')::int INTO committee_level FROM jsonb_array_elements(c."levelsSnapshot") l WHERE (l->>'committee')::boolean LIMIT 1;
  IF committee_level IS NOT NULL AND NEW."level" >= committee_level THEN
    SELECT d."decision"::text INTO latest FROM "CreditCommitteeDecision" d WHERE d."caseId" = NEW."caseId" AND d."level" = committee_level ORDER BY d."seq" DESC LIMIT 1;
    IF latest IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The committee level is approved only while the latest credit committee decision is an approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
