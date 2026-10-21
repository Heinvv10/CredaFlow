-- Learning loop, PR A: automated submission refusals in the decision log
-- (docs/learning-loop/DESIGN.md, decision 5 and §2.5). Additive: two columns
-- and a widened subject CHECK; 20261021090000_credit_decision_record is not
-- changed. A refusal on the public form can name only the website lead (an
-- identity conflict confirms no client), so a lead is a subject too; and a
-- SYSTEM refusal carries the POPIA s71 legal-review flag. Adding a column
-- with a constant default rewrites no row, so the append-only trigger does
-- not fire.
--
-- Rollback (hand-written; Prisma has no down migrations). Run as the migrate
-- role, then re-apply with `npx prisma migrate deploy`:
--   BEGIN;
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_s71_review_automated";
--   ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_has_subject_or_lead";
--   ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject"
--     CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL);
--   ALTER TABLE "CreditDecisionRecord" DROP COLUMN "s71ReviewRequired";
--   ALTER TABLE "CreditDecisionRecord" DROP COLUMN "leadId";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021100000_decision_record_automated_refusal';
--   COMMIT;
-- The restored CHECK fails while a record names only a lead (the table is
-- append-only, so such a row cannot simply be deleted): export those records
-- first, and only on a database that holds none run the rollback as written.

-- AlterTable
ALTER TABLE "CreditDecisionRecord" ADD COLUMN "leadId" TEXT,
ADD COLUMN "s71ReviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- ── Hand-written ────────────────────────────────────────────────────────────

-- A decision is about someone: an application, a loan, a client or a lead.
ALTER TABLE "CreditDecisionRecord" DROP CONSTRAINT "CreditDecisionRecord_has_subject";
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_has_subject_or_lead"
  CHECK ("applicationId" IS NOT NULL OR "loanId" IS NOT NULL OR "clientId" IS NOT NULL OR "leadId" IS NOT NULL);

-- Only an automated decision awaits the s71 review: a staff decision is not
-- "based solely on automated processing".
ALTER TABLE "CreditDecisionRecord" ADD CONSTRAINT "CreditDecisionRecord_s71_review_automated"
  CHECK (NOT "s71ReviewRequired" OR "actorType" = 'SYSTEM');
