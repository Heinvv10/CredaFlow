-- W7 multilingual: per-language native-speaker review acknowledgement
-- (lib/i18n/language-reviews.ts). Additive with a default; validated in code.

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "languageReviews" JSONB NOT NULL DEFAULT '{}';
