-- Learning loop follow-up: decision log retention (docs/learning-loop/DESIGN.md
-- §2.7). A lender may set a retention period; once a record is older than it
-- the nightly job pseudonymises the record: it NULLs the subject ids, the
-- actor, the override reason, the source entity id and the inputs hash, and
-- empties the evidence refs (all of which name or re-identify the person or
-- their application), and keeps the banded aggregate columns. That is the one
-- UPDATE the append-only trigger now lets through, and only when it comes from
-- pseudonymiseCreditDecisionRecords(). Off by default: the column has no
-- default, and the function does nothing for a tenant whose period is NULL.
--
-- THREAT MODEL, stated. The guard lets the UPDATE through only when ALL hold:
--   * the session user is the table's OWNER (pg_class.relowner, not a name):
--     the function is SECURITY DEFINER, owned by the role that runs this
--     migration, so inside it current_user is the owner; any other role,
--     whatever it sets or calls, is refused;
--   * the function's transaction-local flag names this transaction
--     (cf.decision_record_pseudonymise = txid_current()), so even the owner
--     must go through the function (or deliberately set the flag);
--   * the change is exactly the pseudonymisation (columns, to NULL / '{}',
--     once, every other column unchanged).
-- A session that IS the owner (a superuser or the migrate role) can drop the
-- trigger or set the flag, so it is not defended against. TODAY every stack
-- connects as a superuser (docs/ARCHITECTURE.md, "Row-level security:
-- activation checklist"), so until the application role is a non-owner,
-- non-superuser role this protects against code paths, not against a hostile
-- application session; the checklist now says the role must not own the table.
--
-- The function takes no argument: the tenant is the session's tenant frame
-- (app.tenant_id, set by the job; refused when absent) and the clock is now().
-- It is callable by any role (no repo precedent for per-role grants): a caller
-- can only run the nightly job early for its own tenant, on records past the
-- clock, when that tenant has a period set.
--
-- Two additive columns on CreditDecisionRecord/TenantConfig (nullable, no row
-- rewritten); two columns lose NOT NULL; CHECKs are redefined to let a
-- pseudonymised row lack what it no longer has, refusing the same rows as
-- before for every record that is not pseudonymised. The guard function is
-- redefined in place (same name, same TRUNCATE trigger); a separate BEFORE
-- INSERT trigger refuses a record born pseudonymised. No subject-consistency
-- INSERT trigger is touched here (a separate migration adds that).
--
-- The enforcement ships with its code (CLAUDE.md): the job calls the function,
-- and the outcome writer keeps the outcomes of a pseudonymised record.
--
-- Rollback (hand-written; Prisma has no down migrations). Only on a database
-- with no pseudonymised row (the restored NOT NULLs and CHECKs refuse one):
--   BEGIN;
--   DROP TRIGGER "CreditDecisionRecord_no_insert_pseudonymised" ON "CreditDecisionRecord";
--   DROP FUNCTION public."guardCreditDecisionRecordPseudonymisedInsert"();
--   DROP FUNCTION public."pseudonymiseCreditDecisionRecords"();
--   DROP FUNCTION public."agedCreditDecisionRecordIds"(text, integer, timestamp);
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_identity_present";
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_pseudonymised_shape";
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_override_reason";
--   ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_override_reason"
--     CHECK (("overridden" AND "overrideReason" IS NOT NULL AND char_length(btrim("overrideReason")) >= 10)
--       OR (NOT "overridden" AND "overrideReason" IS NULL));
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_actor";
--   ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_actor"
--     CHECK (("actorType" = 'STAFF' AND "actorUserId" IS NOT NULL)
--       OR ("actorType" = 'SYSTEM' AND "actorUserId" IS NULL) OR "actorType" = 'CLIENT');
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_has_subject_or_lead";
--   ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject_or_lead"
--     CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL OR "leadId" IS NOT NULL);
--   -- then re-create guardCreditDecisionRecord() as in 20261021090000_credit_decision_record
--   ALTER TABLE "CreditDecisionRecord" ALTER COLUMN "sourceEntityId" SET NOT NULL, ALTER COLUMN "inputsHash" SET NOT NULL;
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range";
--   ALTER TABLE "TenantConfig" DROP COLUMN "decisionRecordRetentionMonths";
--   ALTER TABLE "CreditDecisionRecord" DROP COLUMN "pseudonymisedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023200000_decision_record_retention';
--   COMMIT;

-- AlterTable
ALTER TABLE "CreditDecisionRecord" ADD COLUMN "pseudonymisedAt" TIMESTAMP(3),
ALTER COLUMN "sourceEntityId" DROP NOT NULL,
ALTER COLUMN "inputsHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "decisionRecordRetentionMonths" INTEGER;

-- ── Hand-written ────────────────────────────────────────────────────────────

-- A period, in months, or off (NULL).
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range"
  CHECK ("decisionRecordRetentionMonths" IS NULL OR ("decisionRecordRetentionMonths" >= 1 AND "decisionRecordRetentionMonths" <= 600));

-- A pseudonymised row holds none of what identified the person or their
-- application.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_pseudonymised_shape"
  CHECK ("pseudonymisedAt" IS NULL OR ("applicationId" IS NULL AND "loanId" IS NULL AND "clientId" IS NULL AND "leadId" IS NULL
    AND "actorUserId" IS NULL AND "overrideReason" IS NULL AND "sourceEntityId" IS NULL AND "inputsHash" IS NULL
    AND "evidenceRefs" = '{}'::jsonb));

-- The source entity and the inputs hash are present until the row is pseudonymised.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_identity_present"
  CHECK ("pseudonymisedAt" IS NOT NULL OR ("sourceEntityId" IS NOT NULL AND "inputsHash" IS NOT NULL));

-- Going against a gate needs a written reason, and a reason is stored only for
-- an override: unless the reason was dropped when the row was pseudonymised.
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_override_reason";
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_override_reason"
  CHECK (("overridden" AND "overrideReason" IS NOT NULL AND char_length(btrim("overrideReason")) >= 10)
    OR ("overridden" AND "pseudonymisedAt" IS NOT NULL AND "overrideReason" IS NULL)
    OR (NOT "overridden" AND "overrideReason" IS NULL));

-- A staff decision names the person (until the row is pseudonymised).
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_actor";
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_actor"
  CHECK (("actorType" = 'STAFF' AND ("actorUserId" IS NOT NULL OR "pseudonymisedAt" IS NOT NULL))
    OR ("actorType" = 'SYSTEM' AND "actorUserId" IS NULL)
    OR "actorType" = 'CLIENT');

-- A decision is about someone (until the row is pseudonymised).
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_has_subject_or_lead";
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject_or_lead"
  CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL OR "leadId" IS NOT NULL
    OR "pseudonymisedAt" IS NOT NULL);

-- The append-only guard (UPDATE, DELETE, TRUNCATE) with one exception: see the
-- threat model above. Every other column must be unchanged: compared as jsonb,
-- so a column added later is protected without editing this function.
CREATE OR REPLACE FUNCTION public."guardCreditDecisionRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  pseudonymised text[] := ARRAY['applicationId', 'loanId', 'clientId', 'leadId', 'actorUserId', 'overrideReason',
                                'sourceEntityId', 'inputsHash', 'evidenceRefs', 'pseudonymisedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('cf.decision_record_pseudonymise', true) = txid_current()::text
       AND current_user = (SELECT pg_get_userbyid(c."relowner") FROM pg_class c WHERE c."oid" = TG_RELID)
       AND OLD."pseudonymisedAt" IS NULL AND NEW."pseudonymisedAt" IS NOT NULL
       AND NEW."applicationId" IS NULL AND NEW."loanId" IS NULL AND NEW."clientId" IS NULL AND NEW."leadId" IS NULL
       AND NEW."actorUserId" IS NULL AND NEW."overrideReason" IS NULL
       AND NEW."sourceEntityId" IS NULL AND NEW."inputsHash" IS NULL AND NEW."evidenceRefs" = '{}'::jsonb
       AND to_jsonb(NEW) - pseudonymised = to_jsonb(OLD) - pseudonymised
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'The credit decision log is append-only';
END;
$function$;

-- A record is never born pseudonymised: that would skip the subject, actor and
-- reason CHECKs, which only a pseudonymisation of an existing row may.
CREATE OR REPLACE FUNCTION public."guardCreditDecisionRecordPseudonymisedInsert"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."pseudonymisedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A credit decision record cannot be created pseudonymised';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CreditDecisionRecord_no_insert_pseudonymised"
  BEFORE INSERT ON "CreditDecisionRecord"
  FOR EACH ROW EXECUTE FUNCTION public."guardCreditDecisionRecordPseudonymisedInsert"();

-- The records of `p_tenant_id` that a retention period of `p_months` has aged
-- at `p_as_of` (UTC). The one definition of the clock, read by the nightly
-- pseudonymisation and by the settings preview that tells a SUPER_ADMIN how
-- many records a period would pseudonymise. Read-only; runs as its caller, so
-- RLS binds it. A record ages from:
--   * the termination of its loan (the loan its loanId names, else the one
--     booked from its application): COALESCE(closedAt, updatedAt) for a
--     settled or cancelled loan, COALESCE(writeOffAt, closedAt, updatedAt) for
--     a written-off one (the write-off route sets writeOffAt, not closedAt;
--     updatedAt is the conservative fallback, never earlier than the end);
--     an open loan (any other status) never ages;
--   * with no loan: its application, when that is still live (DRAFT,
--     SUBMITTED, UNDER_REVIEW, APPROVED), never; a record that names only a
--     client (no application, no loan) does not age while that client has an
--     open loan or a live application; otherwise (declined, cancelled,
--     erased, or only a lead) its decidedAt.
CREATE OR REPLACE FUNCTION public."agedCreditDecisionRecordIds"(p_tenant_id text, p_months integer, p_as_of timestamp)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT clock."id" FROM (
    SELECT r."id",
      CASE
        WHEN loan."id" IS NOT NULL THEN
          CASE loan."status"
            WHEN 'COMPLETED' THEN COALESCE(loan."closedAt", loan."updatedAt")
            WHEN 'CANCELLED' THEN COALESCE(loan."closedAt", loan."updatedAt")
            WHEN 'WRITTEN_OFF' THEN COALESCE(loan."writeOffAt", loan."closedAt", loan."updatedAt")
            ELSE NULL
          END
        WHEN app."status" IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED') THEN NULL
        WHEN r."applicationId" IS NULL AND r."loanId" IS NULL AND r."clientId" IS NOT NULL AND (
          EXISTS (SELECT 1 FROM "Loan" l2 WHERE l2."tenantId" = r."tenantId" AND l2."clientId" = r."clientId"
                  AND l2."status" NOT IN ('COMPLETED', 'WRITTEN_OFF', 'CANCELLED'))
          OR EXISTS (SELECT 1 FROM "LoanApplication" a2 WHERE a2."tenantId" = r."tenantId" AND a2."clientId" = r."clientId"
                     AND a2."status" IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED'))
        ) THEN NULL
        ELSE r."decidedAt"
      END AS "agesFrom"
    FROM "CreditDecisionRecord" r
    LEFT JOIN LATERAL (
      SELECT l."id", l."status", l."closedAt", l."writeOffAt", l."updatedAt" FROM "Loan" l
      WHERE l."tenantId" = r."tenantId" AND (l."id" = r."loanId" OR l."applicationId" = r."applicationId")
      ORDER BY (l."id" = r."loanId") DESC
      LIMIT 1
    ) loan ON true
    LEFT JOIN "LoanApplication" app ON app."id" = r."applicationId" AND app."tenantId" = r."tenantId"
    WHERE r."tenantId" = p_tenant_id AND r."pseudonymisedAt" IS NULL
  ) clock
  WHERE clock."agesFrom" IS NOT NULL AND clock."agesFrom" + make_interval(months => p_months) <= p_as_of
$function$;

-- Pseudonymise the session's tenant's aged records and return how many. The
-- tenant is the tenant frame (app.tenant_id); with none it refuses. The
-- lender's period is read here (NULL: off, nothing changes). SECURITY DEFINER
-- so that the guard can tell it from any other session (threat model above);
-- the tenant is filtered explicitly, and RLS (FORCE) binds the owner too.
-- Its outcomes keep their figures but lose sourceRef, which names the loan.
CREATE OR REPLACE FUNCTION public."pseudonymiseCreditDecisionRecords"()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  tenant text := public.cf_rls_tenant();
  months integer;
  as_of timestamp := now() AT TIME ZONE 'UTC';
  changed integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'pseudonymiseCreditDecisionRecords needs a tenant frame' USING ERRCODE = '22023';
  END IF;
  SELECT c."decisionRecordRetentionMonths" INTO months FROM "TenantConfig" c WHERE c."tenantId" = tenant;
  IF months IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM set_config('cf.decision_record_pseudonymise', txid_current()::text, true);
  WITH done AS (
    UPDATE "CreditDecisionRecord" r
    SET "applicationId" = NULL, "loanId" = NULL, "clientId" = NULL, "leadId" = NULL,
        "actorUserId" = NULL, "overrideReason" = NULL, "sourceEntityId" = NULL, "inputsHash" = NULL,
        "evidenceRefs" = '{}'::jsonb, "pseudonymisedAt" = as_of
    FROM public."agedCreditDecisionRecordIds"(tenant, months, as_of) AS aged("id")
    WHERE r."id" = aged."id" AND r."tenantId" = tenant
    RETURNING r."id"
  ), freed AS (
    UPDATE "DecisionOutcome" o SET "sourceRef" = o."id"
    FROM done WHERE o."decisionRecordId" = done."id" AND o."tenantId" = tenant
    RETURNING 1
  )
  SELECT count(*)::integer INTO changed FROM done;
  PERFORM set_config('cf.decision_record_pseudonymise', '', true);
  RETURN changed;
END;
$function$;
