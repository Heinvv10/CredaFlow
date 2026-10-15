-- A byte-identical re-upload of the verified ID copy is not a replacement.
--
-- RELAXING, not enforcement-adding: safe to apply ahead of or after the code
-- (lib/kyc/id-replacement.ts, pendingIdReplacement). Until both ship, the
-- TypeScript can only be stricter than the database (it still holds such a
-- client at PENDING), and the database accepts every write that implies.
--
-- 20261014130000 made the newest non-refused, unverified ID copy hold the
-- client at PENDING while an older copy is verified. A client who uploaded the
-- very same file again was therefore demoted for nothing. Now, when that copy's
-- contentSha256 equals the contentSha256 of the current verified copy (the
-- newest verified one, chosen in the same order), it is not a pending
-- replacement. Both digests must be well-formed lowercase SHA-256: a NULL or
-- malformed digest on either side never matches, so the copy stays pending
-- (fail closed). A copy matching an OLDER verified copy, not the current one,
-- is still a replacement.
--
-- subject_has_pending_id_replacement is the 20261014130000 body with the
-- inner select also reading "contentSha256" and ONE added condition,
-- delimited by BEGIN/END comments
-- (lib/kyc/id-identical-reupload-migration.test.ts compares the two bodies).
-- subject_has_composite_kyc, and through it client_has_composite_kyc,
-- Client_enforce_composite_kyc and the ClientDocument revoke trigger, read
-- this function, so the change holds for every writer without touching them.
--
-- No data step. Nothing currently VERIFIED becomes invalid (the rule only
-- narrows). A client demoted earlier by an identical re-upload stays PENDING:
-- a migration never promotes to VERIFIED. The staff client KYC tab shows a
-- re-verify hint when the evidence would derive VERIFIED again.

CREATE OR REPLACE FUNCTION public.subject_has_pending_id_replacement(p_tenant_id text, p_client_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "ClientDocument" AS verified_copy
    WHERE verified_copy."tenantId" = p_tenant_id
      AND verified_copy."clientId" = p_client_id
      AND verified_copy."docType" = 'ID_COPY'
      AND verified_copy."deletedAt" IS NULL
      AND verified_copy."verified" = true
  )
  AND coalesce(
    (
      SELECT newest."verified" = false
        -- BEGIN identical-reupload rule (20261015130000_identical_id_reupload_not_replacement).
        -- The newest copy is no replacement when its bytes are the current
        -- verified copy's. NULL anywhere makes the coalesce false: pending.
        -- Mirrors pendingIdReplacement in lib/kyc/id-replacement.ts.
        AND NOT coalesce(
          newest."contentSha256" ~ '^[a-f0-9]{64}$'
          AND newest."contentSha256" = (
            SELECT current_copy."contentSha256"
            FROM "ClientDocument" AS current_copy
            WHERE current_copy."tenantId" = p_tenant_id
              AND current_copy."clientId" = p_client_id
              AND current_copy."docType" = 'ID_COPY'
              AND current_copy."deletedAt" IS NULL
              AND current_copy."verified" = true
            ORDER BY current_copy."createdAt" DESC, current_copy."id" COLLATE "C" DESC
            LIMIT 1
          ),
          false
        )
        -- END identical-reupload rule
      FROM (
        SELECT candidate."verified", candidate."contentSha256"
        FROM "ClientDocument" AS candidate
        WHERE candidate."tenantId" = p_tenant_id
          AND candidate."clientId" = p_client_id
          AND candidate."docType" = 'ID_COPY'
          AND candidate."deletedAt" IS NULL
          AND candidate."verificationRejectedAt" IS NULL
          AND candidate."verificationRejectedById" IS NULL
        ORDER BY candidate."createdAt" DESC, candidate."id" COLLATE "C" DESC
        LIMIT 1
      ) AS newest
    ),
    false
  );
$function$;
