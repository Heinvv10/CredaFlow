-- Jurisdiction and currency of the lender (lib/jurisdiction). Additive and
-- backward compatible: every existing row becomes ZA / ZAR, which is what the
-- code has always assumed. No trigger or CHECK; the enums are the constraint.
CREATE TYPE "Jurisdiction" AS ENUM ('ZA', 'LS');
CREATE TYPE "LenderCurrency" AS ENUM ('ZAR', 'LSL');

ALTER TABLE "TenantConfig"
  ADD COLUMN "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'ZA',
  ADD COLUMN "currency" "LenderCurrency" NOT NULL DEFAULT 'ZAR';
