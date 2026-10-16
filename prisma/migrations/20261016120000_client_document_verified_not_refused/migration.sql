-- A ClientDocument is either verified or refused, never both.
--
-- ENFORCEMENT-ADDING. The one writer of the refusal markers, the staff verify
-- route (app/api/clients/[id]/documents/[docId]/verify/route.ts), sets
-- verified and clears both markers in the same write, and refusing clears
-- verified. Every other writer that sets verified = true either creates the
-- row (markers NULL) or updates only rows its WHERE proves were never refused
-- (agreement signing: the verify route refuses those document types; the
-- selfie outcome writer: a refusal always carries a verificationNote, which
-- its WHERE requires to be NULL). Those writers never clear a refusal: a row
-- that somehow holds one fails the write here, closed.
--
-- Rules that read the markers independently of verified (pendingIdReplacement
-- and subject_has_pending_id_replacement, isAdversePriorAttempt, the in-person
-- lapse rule) assumed this; the database now guarantees it.
--
-- 1. Pre-check: abort with the count of rows that already violate it. Never
--    auto-fixed: which side is true is a staff decision (rollout confirmation
--    gate, as 20261013213000 does for clear-mismatch exceptions).
-- 2. The CHECK.

DO $precheck$
DECLARE violating bigint;
BEGIN
  SELECT count(*) INTO violating
  FROM "ClientDocument"
  WHERE "verified" = true
    AND ("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL);
  IF violating > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('%s ClientDocument row(s) are verified and also carry a refusal marker; resolve them before applying this migration', violating);
  END IF;
END;
$precheck$;

ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_verified_not_refused_check" CHECK (NOT ("verified" AND ("verificationRejectedAt" IS NOT NULL OR "verificationRejectedById" IS NOT NULL)));
