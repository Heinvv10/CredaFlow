-- F7, tender 2.3.9. A lender outside the NCA may let the decision engine attest affordability itself, so that a digital
-- key-facts application with a bureau check is approved with no person (lib/decisioning/key-facts-referral.ts). Off by
-- default, set only through an approved DECISION_ENGINE_CONFIG change. The rule that makes it safe for South Africa lives here:
--   1. DecisionEngineConfig.keyFactsInstantApproval cannot be true on an instance that is South African or has no row.
--   2. CHECK LoanApplication_automated_affordability: an attestation sits on a KEY_FACTS application only, past review.
--   3. guardLoanApplicationAutomatedAffordability: it is stamped only with the system user's approval, with the setting on
--      when that approval commits (read FOR SHARE: a withdrawal waits for this commit, or this one sees it) and a successful
--      bureau check of the current review on file; it cannot be edited afterwards. An engine approval of a key-facts
--      application with no attestation is refused, so with the setting off the engine cannot approve one at all.
-- An NCA_PASQ application keeps every rule it had: nothing here reads or stamps the reckless-lending assessment.
-- Additive: no row carries an attestation, no lender has the setting on, and the engine cannot have approved a key-facts
-- application in production (none has a bureau check: the review skips it). Ships with the code that stamps it.

ALTER TABLE "DecisionEngineConfig" ADD COLUMN "keyFactsInstantApproval" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LoanApplication"
  ADD COLUMN "automatedAffordabilityAttestedAt" TIMESTAMP(3),
  ADD COLUMN "automatedAffordabilityVersionId" TEXT;

ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_automatedAffordabilityVersionId_fkey"
  FOREIGN KEY ("tenantId", "automatedAffordabilityVersionId") REFERENCES "DecisionRuleSetVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_automated_affordability" CHECK (
  ("automatedAffordabilityAttestedAt" IS NULL) = ("automatedAffordabilityVersionId" IS NULL)
  AND ("automatedAffordabilityAttestedAt" IS NULL OR (
    "disclosureRegime" = 'KEY_FACTS'::"DisclosureRegime" AND "status" IN ('APPROVED'::"AppStatus", 'DISBURSED'::"AppStatus", 'CANCELLED'::"AppStatus")
  ))
);

CREATE FUNCTION public."guardLoanApplicationAutomatedAffordability"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  approving BOOLEAN;
  stamped BOOLEAN;
  by_system BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."automatedAffordabilityAttestedAt" IS NOT NULL OR NEW."automatedAffordabilityVersionId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An automated affordability attestation is stamped with the engine''s approval, never at creation';
    END IF;
    RETURN NEW;
  END IF;

  approving := NEW."status" = 'APPROVED' AND OLD."status" IS DISTINCT FROM 'APPROVED';
  stamped := NEW."automatedAffordabilityAttestedAt" IS DISTINCT FROM OLD."automatedAffordabilityAttestedAt"
    OR NEW."automatedAffordabilityVersionId" IS DISTINCT FROM OLD."automatedAffordabilityVersionId";

  -- It goes when the approval goes (a return to review or to draft), and it does not otherwise change.
  IF stamped AND NOT approving AND NOT (NEW."automatedAffordabilityAttestedAt" IS NULL AND NEW."automatedAffordabilityVersionId" IS NULL AND OLD."status" = 'APPROVED' AND NEW."status" IN ('DRAFT', 'UNDER_REVIEW')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An automated affordability attestation is written only with the engine''s approval and cannot be changed';
  END IF;
  IF NOT approving THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."approvedById" AND u."tenantId" = NEW."tenantId" AND u."isSystem") INTO by_system;
  IF by_system AND NEW."disclosureRegime" = 'KEY_FACTS' AND NEW."automatedAffordabilityAttestedAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The decision engine approves a key-facts application only on an automated affordability attestation';
  END IF;
  IF NEW."automatedAffordabilityAttestedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT by_system THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An automated affordability attestation belongs to the decision engine''s approval, not a person''s';
  END IF;
  PERFORM 1 FROM "DecisionEngineConfig" c WHERE c."tenantId" = NEW."tenantId" AND c."keyFactsInstantApproval" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The lender''s instant key-facts approval setting is not on';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "CreditBureauCheck" b
    WHERE b."tenantId" = NEW."tenantId" AND b."applicationId" = NEW."id" AND b."clientId" = NEW."clientId" AND b."ok"
      AND b."reviewGeneration" = NEW."bureauReviewGeneration"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A key-facts application with no bureau check of this review is never approved automatically';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanApplication_guard_automated_affordability"
  BEFORE INSERT OR UPDATE OF "status", "approvedById", "automatedAffordabilityAttestedAt", "automatedAffordabilityVersionId" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanApplicationAutomatedAffordability"();

-- guardDecisionEngineConfig: the setting is part of what must match the approved payload (a request drafted before it
-- existed has no key: off), and it cannot be on where the NCA applies. A database with no InstanceJurisdiction row is South African.
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef('public."guardDecisionEngineConfig"()'::regprocedure) INTO definition;
  changed := replace(definition,
    $sql$    OR NEW."challengerVersionId" IS DISTINCT FROM (req."payload" ->> 'challengerVersionId')$sql$,
    $sql$    OR NEW."challengerVersionId" IS DISTINCT FROM (req."payload" ->> 'challengerVersionId')
    OR NEW."keyFactsInstantApproval" IS DISTINCT FROM COALESCE((req."payload" ->> 'keyFactsInstantApproval')::BOOLEAN, false)$sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardDecisionEngineConfig payload shape changed'; END IF;
  definition := changed;
  changed := replace(definition,
    $sql$  -- The sign-off is given by the checker who approved it, or carried over unchanged.$sql$,
    $sql$  IF NEW."keyFactsInstantApproval" AND COALESCE((SELECT i."jurisdiction"::TEXT FROM "InstanceJurisdiction" i WHERE i."id" = 1), 'ZA') = 'ZA' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Instant key-facts approval cannot be switched on where the National Credit Act applies';
  END IF;
  -- The sign-off is given by the checker who approved it, or carried over unchanged.$sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardDecisionEngineConfig sign-off shape changed'; END IF;
  EXECUTE changed;
END;
$body$;
