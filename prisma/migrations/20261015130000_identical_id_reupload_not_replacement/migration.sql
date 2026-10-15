-- Any different, unreviewed ID copy after the verified one holds the client;
-- a byte-identical re-upload of the verified copy does not.
--
-- Ships with lib/kyc/id-replacement.ts (pendingIdReplacement), which derives
-- the same rule. It relaxes one case (an identical re-upload no longer
-- demotes) and tightens none that any writer can produce: for copies of other
-- bytes the verdict is 20261014130000's (see below).
--
-- 20261014130000 held the client at PENDING when the NEWEST non-refused ID
-- copy was unverified while an older copy was verified. Now:
--
--   current copy = the newest verified, non-deleted ID copy, ordered
--                  createdAt DESC, id COLLATE "C" DESC (the copy
--                  subject_has_composite_kyc and pendingIdReplacement rest on);
--   the client is held while ANY non-deleted ID copy that is unverified,
--   unrefused (neither verificationRejectedAt nor verificationRejectedById),
--   and created after the current copy in that same order, is not a
--   byte-identical re-upload of it.
--
-- Byte-identical: both contentSha256 well-formed lowercase SHA-256 and equal.
-- A NULL digest on either side never matches, so that copy holds (fail
-- closed). Matching an older verified copy, or a deleted one, does not count.
-- A newer identical copy cannot hide an older different one: every copy after
-- the current one is checked, not only the newest.
--
-- Same verdict as 20261014130000 for copies of other bytes while no verified
-- copy also carries a refusal marker (the verify route sets verified and
-- clears refusal together): the newest unrefused copy is unverified exactly
-- when some unrefused, unverified copy is newer than every verified one.
--
-- subject_has_composite_kyc, and through it client_has_composite_kyc,
-- Client_enforce_composite_kyc and the ClientDocument revoke trigger, read
-- this function, so the rule holds for every writer without touching them.
-- lib/kyc/id-identical-reupload-migration.test.ts pins this body.
--
-- No data step. A client this would newly hold is not VERIFIED today (a
-- different unreviewed copy already outweighed the verified one when it was
-- the newest, and a later identical upload demoted the client under
-- 20261014130000). A client demoted by an identical re-upload alone stays
-- PENDING: a migration never promotes; staff re-derive from the KYC tab.

CREATE OR REPLACE FUNCTION public.subject_has_pending_id_replacement(p_tenant_id text, p_client_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT verified_copy."createdAt", verified_copy."id", verified_copy."contentSha256"
      FROM "ClientDocument" AS verified_copy
      WHERE verified_copy."tenantId" = p_tenant_id
        AND verified_copy."clientId" = p_client_id
        AND verified_copy."docType" = 'ID_COPY'
        AND verified_copy."deletedAt" IS NULL
        AND verified_copy."verified" = true
      ORDER BY verified_copy."createdAt" DESC, verified_copy."id" COLLATE "C" DESC
      LIMIT 1
    ) AS current_copy
    JOIN "ClientDocument" AS candidate
      ON candidate."tenantId" = p_tenant_id
      AND candidate."clientId" = p_client_id
      AND candidate."docType" = 'ID_COPY'
      AND candidate."deletedAt" IS NULL
      AND candidate."verified" = false
      AND candidate."verificationRejectedAt" IS NULL
      AND candidate."verificationRejectedById" IS NULL
      -- Created after the current copy, in the order that chose it.
      AND (
        candidate."createdAt" > current_copy."createdAt"
        OR (
          candidate."createdAt" = current_copy."createdAt"
          AND candidate."id" COLLATE "C" > current_copy."id" COLLATE "C"
        )
      )
    -- Not a byte-identical re-upload of the current copy. NULL anywhere makes
    -- the coalesce false, so such a copy holds the client.
    WHERE NOT coalesce(
      candidate."contentSha256" ~ '^[a-f0-9]{64}$'
      AND candidate."contentSha256" = current_copy."contentSha256",
      false
    )
  );
$function$;
