-- Learning loop follow-up: decision log retention (docs/learning-loop/DESIGN.md
-- §2.7). A lender may set a retention period; once a record is older than it
-- the nightly job pseudonymises the record (NULLs its subject ids, its actor
-- and its override reason, keeps the banded aggregate columns). That is the
-- one UPDATE the append-only trigger now lets through, and only when it comes
-- from pseudonymiseCreditDecisionRecords(). Off by default: the column has no
-- default, and the function does nothing for a tenant whose period is NULL.
--
-- Two additive columns (nullable, so no row is rewritten and the trigger does
-- not fire). Three CHECKs are redefined to let a pseudonymised row be
-- subject-less, actor-less and reason-less; they refuse the same rows as
-- before for every record that is not pseudonymised. The guard function is
-- redefined in place (same name, same TRUNCATE trigger); the INSERT-side of
-- the table is not touched.
--
-- The enforcement ships with its code (CLAUDE.md): the job calls the function,
-- and the outcome writer keeps the outcomes of a pseudonymised record.
--
-- Rollback (hand-written; Prisma has no down migrations). Only on a database
-- with no pseudonymised row (the restored CHECKs refuse a subject-less one):
--   BEGIN;
--   DROP FUNCTION public."pseudonymiseCreditDecisionRecords"(text, timestamptz);
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
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range";
--   ALTER TABLE "TenantConfig" DROP COLUMN "decisionRecordRetentionMonths";
--   ALTER TABLE "CreditDecisionRecord" DROP COLUMN "pseudonymisedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261023200000_decision_record_retention';
--   COMMIT;

-- AlterTable
ALTER TABLE "CreditDecisionRecord" ADD COLUMN "pseudonymisedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "decisionRecordRetentionMonths" INTEGER;

-- ── Hand-written ────────────────────────────────────────────────────────────

-- A period, in months, or off (NULL).
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range"
  CHECK ("decisionRecordRetentionMonths" IS NULL OR ("decisionRecordRetentionMonths" >= 1 AND "decisionRecordRetentionMonths" <= 600));

-- A pseudonymised row holds none of what identified the person.
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_pseudonymised_shape"
  CHECK ("pseudonymisedAt" IS NULL OR ("applicationId" IS NULL AND "loanId" IS NULL AND "clientId" IS NULL AND "leadId" IS NULL
    AND "actorUserId" IS NULL AND "overrideReason" IS NULL));

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

-- The append-only guard (UPDATE, DELETE, TRUNCATE) with one exception: an
-- UPDATE that is made by pseudonymiseCreditDecisionRecords() (found on the
-- call stack, which a plain statement cannot forge) and changes exactly the
-- seven pseudonymisation columns of a row that was not yet pseudonymised, the
-- identifying six to NULL. Every other column must be unchanged: compared as
-- jsonb, so a column added later is protected without editing this function.
CREATE OR REPLACE FUNCTION public."guardCreditDecisionRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  stack text;
  pseudonymised text[] := ARRAY['applicationId', 'loanId', 'clientId', 'leadId', 'actorUserId', 'overrideReason', 'pseudonymisedAt'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    GET DIAGNOSTICS stack = PG_CONTEXT;
    IF stack LIKE '%PL/pgSQL function "pseudonymiseCreditDecisionRecords"(%'
       AND OLD."pseudonymisedAt" IS NULL AND NEW."pseudonymisedAt" IS NOT NULL
       AND NEW."applicationId" IS NULL AND NEW."loanId" IS NULL AND NEW."clientId" IS NULL AND NEW."leadId" IS NULL
       AND NEW."actorUserId" IS NULL AND NEW."overrideReason" IS NULL
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

-- Pseudonymise one lender's aged records and return how many. The lender's
-- period is read here (NULL: off, nothing changes), so the job passes no
-- period. SECURITY INVOKER: it runs as the caller, in the caller's tenant
-- frame, and RLS confines it to that tenant; the tenant argument is checked
-- as well. A record ages from:
--   * the termination of its loan (the loan its loanId names, else the one
--     booked from its application): COALESCE(closedAt, updatedAt) for a
--     settled or cancelled loan, COALESCE(writeOffAt, closedAt, updatedAt) for
--     a written-off one (the write-off route sets writeOffAt, not closedAt;
--     updatedAt is the conservative fallback, never earlier than the end);
--     an open loan (any other status) never ages;
--   * with no loan: its application, when that is still live (DRAFT,
--     SUBMITTED, UNDER_REVIEW, APPROVED), never; otherwise (declined,
--     cancelled, erased, or no application at all: a lead or client only)
--     its decidedAt.
-- It is the only code that may make the guard's one exception.
CREATE OR REPLACE FUNCTION public."pseudonymiseCreditDecisionRecords"(p_tenant_id text, p_as_of timestamptz)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  months integer;
  as_of timestamp := p_as_of AT TIME ZONE 'UTC';
  changed integer;
BEGIN
  SELECT c."decisionRecordRetentionMonths" INTO months FROM "TenantConfig" c WHERE c."tenantId" = p_tenant_id;
  IF months IS NULL THEN
    RETURN 0;
  END IF;

  WITH aged AS (
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
  )
  UPDATE "CreditDecisionRecord" r
  SET "applicationId" = NULL, "loanId" = NULL, "clientId" = NULL, "leadId" = NULL,
      "actorUserId" = NULL, "overrideReason" = NULL, "pseudonymisedAt" = as_of
  FROM aged
  WHERE r."id" = aged."id" AND r."tenantId" = p_tenant_id
    AND aged."agesFrom" IS NOT NULL AND aged."agesFrom" + make_interval(months => months) <= as_of;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END;
$function$;
