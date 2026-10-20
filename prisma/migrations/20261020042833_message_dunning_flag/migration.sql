-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "dunning" BOOLEAN NOT NULL DEFAULT false;

-- One-off backfill, so a reminder already queued when this ships is held by the
-- retry sweep's client hold like one created afterwards (lib/messaging/retry.ts).
-- Only rows that can still be retried or dispatched: RETRYING and QUEUED.
--
-- A Message row carries no category (sendMessage stores `dunning` from the send's
-- category from now on), so the reminder is recognised by its template's event,
-- the names of lib/messaging/default-templates.ts. Reminders sent through the
-- shared agent-message template (the manual reminder, the collections-stage
-- WhatsApp) cannot be told from an inbox reply and are left false: those rows
-- are staff-initiated and were checked when they were sent.
--
-- Message is row-level-secured by tenant (20261014130000_tenant_rls) and a
-- migration has no tenant: bypass for the UPDATE only, as
-- 20261016210000_retype_asset_finance_products does. Safe to re-run: it only
-- ever sets false to true.
SELECT set_config('app.rls_bypass', 'on', false);

UPDATE "Message" AS m
SET "dunning" = true
FROM "MessageTemplate" AS t
WHERE m."templateId" = t."id"
  AND m."dunning" = false
  AND m."status" IN ('RETRYING', 'QUEUED')
  AND t."event" IN (
    'loan_overdue', 'loan_overdue_1d', 'loan_overdue_7d',
    'payment_due_3d', 'payment_reminder_sent',
    'payment_reminder_0d', 'payment_reminder_0d_v2', 'payment_reminder_0d_v3',
    'payment_reminder_1d', 'payment_reminder_7d',
    'payment_reminder_overdue_1d', 'payment_reminder_overdue_3d',
    'entity_payment_due', 'entity_payment_overdue', 'entity_reminder'
  );

SELECT set_config('app.rls_bypass', '', false);
