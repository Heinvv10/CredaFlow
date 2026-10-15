-- W7 multilingual (lib/i18n). Additive and backward compatible: a nullable
-- column and a column with a default. No enforcement is added; the values are
-- validated in code (lib/i18n/locales.ts), because the set of languages is
-- product configuration, not a compliance invariant.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "preferredLanguage" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "enabledLanguages" TEXT[] DEFAULT ARRAY['en']::TEXT[];
