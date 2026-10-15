-- Asset finance slice 4b: asset-finance journal sources add account roles
-- (lib/accounting/accounts.ts). A lender that confirmed its chart-of-accounts
-- mapping before they existed has not confirmed them: the roles a confirmation
-- covers are listed beside it, and a month that posts a role not listed is
-- refused until the mapping is confirmed again. Additive: one array column
-- defaulting to none, so a deploy of the migration ahead of the code changes
-- nothing (the roles that predate asset finance need only mappingConfirmedAt).
ALTER TABLE "AccountingSettings" ADD COLUMN "mappingConfirmedRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];
