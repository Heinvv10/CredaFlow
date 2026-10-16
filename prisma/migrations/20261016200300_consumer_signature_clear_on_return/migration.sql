-- Segregation of duties, review round 2 (PR #140).
--
-- A recorded consumer signature may be cleared as a whole only in the same
-- write that returns the application to review or to draft (the decide
-- route's return_to_review / return_to_draft). A bare clear while APPROVED let
-- an in-branch signature be retaken with a colleague as witness, after which
-- the original witness could countersign their own signing session.

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public."guardLoanApplicationConsumerSignature"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."agreementSignedAt" IS NOT NULL
    AND (
      NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
      OR NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
      OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
      OR NEW."agreementSignedByIp" IS DISTINCT FROM OLD."agreementSignedByIp"
      OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"
    )
    AND NOT (
      NEW."agreementSignedAt" IS NULL
      AND NEW."agreementSignedMethod" IS NULL
      AND NEW."agreementSignedByUserId" IS NULL
      AND NEW."agreementSignedByIp" IS NULL
      AND NEW."agreementSignatureData" IS NULL
      AND NEW."status" IS DISTINCT FROM OLD."status"
      AND NEW."status" IN ('UNDER_REVIEW', 'DRAFT')
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A recorded consumer signature is immutable; return the application to review to take a new one';
  END IF;
  RETURN NEW;
END;
$function$;
