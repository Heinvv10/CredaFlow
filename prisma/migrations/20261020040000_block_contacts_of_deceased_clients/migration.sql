-- Recording a death now blocks the client's messaging Contact in the same
-- transaction (app/api/clients/[id]/status/route.ts, lib/clients/deceased-contacts.ts).
-- This blocks the Contacts of clients whose death was recorded BEFORE that code.
--
-- Data only, no new constraint: safe to apply ahead of the code, and safe to
-- re-run. Only a CLIENT Contact is touched, and it is BLOCKED afterwards, so a
-- second run matches nothing. The reason is the same marker the code writes,
-- which is how a reversed death re-opens exactly these rows. An existing
-- "blockedAt" (an earlier suppression event) is kept.
--
-- Contact is row-level-secured by tenant (20261014130000_tenant_rls) and a
-- migration has no tenant: bypass for the UPDATE only, as
-- 20261016210000_retype_asset_finance_products does.
SELECT set_config('app.rls_bypass', 'on', false);

UPDATE "Contact" AS c
SET "status" = 'BLOCKED',
    "blockedReason" = 'DECEASED: client death recorded',
    "blockedAt" = COALESCE(c."blockedAt", NOW()),
    "updatedAt" = NOW()
FROM "Client" AS cl
WHERE c."clientId" = cl."id"
  AND cl."deceasedAt" IS NOT NULL
  AND c."status" = 'CLIENT';

SELECT set_config('app.rls_bypass', '', false);
