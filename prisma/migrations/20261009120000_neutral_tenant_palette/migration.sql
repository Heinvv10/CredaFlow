-- CredaFlow's neutral default palette for new TenantConfig rows. Defaults
-- only: existing rows keep their colours.
ALTER TABLE "TenantConfig" ALTER COLUMN "primaryColor" SET DEFAULT '#4F46E5';
ALTER TABLE "TenantConfig" ALTER COLUMN "secondaryColor" SET DEFAULT '#4338CA';
ALTER TABLE "TenantConfig" ALTER COLUMN "darkColor" SET DEFAULT '#0B0D12';
