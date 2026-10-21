-- Valuation guides (docs/asset-finance/SLICE5.md part C): a valuation read
-- from a published guide row. On its own because a new enum value cannot be
-- used in the transaction that adds it (20261021090100_valuation_guides
-- checks for it).

-- AlterEnum
ALTER TYPE "ValuationSource" ADD VALUE 'GUIDE';
