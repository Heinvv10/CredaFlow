-- Per-lender opt-in for the automation engine's WhatsApp rules. Additive and
-- defaulted OFF, so it is safe to apply ahead of the code that reads it.

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "automatedWhatsAppReminders" BOOLEAN NOT NULL DEFAULT false;
