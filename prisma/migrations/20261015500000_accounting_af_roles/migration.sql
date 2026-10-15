-- Asset finance slice 4b: asset-finance journal sources add account roles
-- (lib/accounting/accounts.ts). A lender that confirmed its chart-of-accounts
-- mapping before they existed has not confirmed them: the roles a confirmation
-- covers are listed beside it, and a month that posts a role not listed is
-- refused until the mapping is confirmed again. Additive: one array column
-- defaulting to none, so a deploy of the migration ahead of the code changes
-- nothing (the roles that predate asset finance need only mappingConfirmedAt).
-- The closed-month tables also refuse TRUNCATE (below).
ALTER TABLE "AccountingSettings" ADD COLUMN "mappingConfirmedRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- A closed month is final (20261015090000): its row guards refuse UPDATE and DELETE, but a row trigger never
-- sees TRUNCATE, which would empty the ledger in one statement. A statement trigger refuses it.
-- Additive: no row changes, and only the app role's TRUNCATE (which it never issues) is refused.
CREATE OR REPLACE FUNCTION public."refuseAccountingTruncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = format('Accounting guard: %s is part of the closed months and is never truncated', TG_TABLE_NAME);
END;
$function$;

CREATE TRIGGER "AccountingExportBatch_no_truncate" BEFORE TRUNCATE ON "AccountingExportBatch" FOR EACH STATEMENT EXECUTE FUNCTION public."refuseAccountingTruncate"();
CREATE TRIGGER "AccountingLedgerEntry_no_truncate" BEFORE TRUNCATE ON "AccountingLedgerEntry" FOR EACH STATEMENT EXECUTE FUNCTION public."refuseAccountingTruncate"();
CREATE TRIGGER "AccountingJournalLine_no_truncate" BEFORE TRUNCATE ON "AccountingJournalLine" FOR EACH STATEMENT EXECUTE FUNCTION public."refuseAccountingTruncate"();
