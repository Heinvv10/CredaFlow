-- Learning loop: a 60-month floor on the decision log retention period
-- (docs/learning-loop/DESIGN.md §2.7). A lender may pseudonymise its credit
-- decision records no sooner than five years after they age: FICA keeps
-- records for five years, longer than the NCA regulations' three. Null (off)
-- and the 600-month ceiling are unchanged.
--
-- No period is clamped: raising a lender's period would change its legal
-- setting without an audit row. A row set to 1..59 aborts the migration; set
-- it through the settings card (audited) first.
--
-- The enforcement ships with its code (CLAUDE.md): RETENTION_MONTHS_MIN is 60
-- in lib/learning-loop/retention/policy.ts.
--
-- Rollback (hand-written; Prisma has no down migrations):
--   BEGIN;
--   ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range";
--   ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range"
--     CHECK ("decisionRecordRetentionMonths" IS NULL OR ("decisionRecordRetentionMonths" >= 1 AND "decisionRecordRetentionMonths" <= 600));
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261024150000_decision_record_retention_floor';
--   COMMIT;

-- ── Hand-written ────────────────────────────────────────────────────────────

DO $$
DECLARE
  below integer;
BEGIN
  SELECT count(*) INTO below FROM "TenantConfig" WHERE "decisionRecordRetentionMonths" BETWEEN 1 AND 59;
  IF below > 0 THEN
    RAISE EXCEPTION '% TenantConfig row(s) set a decision record retention period under 60 months; set them to 60..600 or off through the settings card, then re-run', below;
  END IF;
END
$$;

-- A period, in months (60 to 600), or off (NULL).
ALTER TABLE "TenantConfig" DROP CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range";
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_decisionRecordRetentionMonths_range"
  CHECK ("decisionRecordRetentionMonths" IS NULL OR ("decisionRecordRetentionMonths" >= 60 AND "decisionRecordRetentionMonths" <= 600));
