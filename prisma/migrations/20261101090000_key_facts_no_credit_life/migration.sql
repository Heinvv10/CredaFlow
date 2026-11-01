-- A key-facts loan (a jurisdiction without the NCA) carries no credit life: it is billed under South African
-- regulations, so decide-application prices a KEY_FACTS loan with none and refuses an ACCEPTED election
-- (lib/non-nca-documents/regime-evidence.ts). guardLoanApplicationCreditLifeOffer steps aside for KEY_FACTS
-- (20261030090000_non_nca_documents), so nothing in the database refused a direct write approving such a row with
-- cover. This CHECK does. NCA_PASQ rows are judged exactly as before: the expression is true for them.
--
-- Additive on existing data: no KEY_FACTS row is approved with cover (decide refuses it), and every NCA_PASQ row passes.
-- A KEY_FACTS row not yet approved is outside this CHECK, so the code refuses cover before it gets here.
-- It takes effect immediately, so it ships with the code that already refuses the same thing.
--
-- Rollback (hand-written; Prisma has no down migrations):
--   ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_key_facts_no_credit_life";
--   and delete the migration row.

ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_key_facts_no_credit_life"
  CHECK (
    "disclosureRegime" <> 'KEY_FACTS'
    OR "status"::TEXT NOT IN ('APPROVED', 'DISBURSED')
    OR "creditLifeElection" IS DISTINCT FROM 'ACCEPTED'
  );
