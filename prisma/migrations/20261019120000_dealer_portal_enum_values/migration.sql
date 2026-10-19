-- Dealer portal (docs/asset-finance/SLICE5.md part A): a dealer-uploaded
-- POPIA consent form. On its own because a new enum value cannot be used in
-- the transaction that adds it (20261019120100_dealer_portal checks for it).

-- AlterEnum
ALTER TYPE "EntityDocumentType" ADD VALUE 'POPIA_CONSENT';
