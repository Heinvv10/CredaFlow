-- Repricing must preserve the contract's payment shape. The last scheduled
-- payment includes a rounding residue, so its weight cannot be reconstructed
-- reliably from the stored payment amount.
ALTER TABLE "Loan" ADD COLUMN "assetFinanceWeights" JSONB;
