-- Per-tenant provider credentials (W0). Experian and Stitch were read from the
-- deployment's environment, so every lender on a shared platform would have
-- used one lender's accounts. The *Key and *Secret columns hold values sealed
-- by lib/crypto/secret-box.ts (lib/integrations/tenant-credentials.ts).
-- Additive and nullable.
ALTER TABLE "TenantConfig"
  ADD COLUMN "experianKey" TEXT,
  ADD COLUMN "stitchKey" TEXT,
  ADD COLUMN "stitchWebhookSecret" TEXT,
  ADD COLUMN "stitchBeneficiaryName" TEXT,
  ADD COLUMN "stitchBankId" TEXT,
  ADD COLUMN "stitchAccountNumber" TEXT,
  ADD COLUMN "stitchBranchCode" TEXT;
