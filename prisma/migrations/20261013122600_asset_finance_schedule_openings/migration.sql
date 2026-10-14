-- A payment reversal can reopen a row whose historical interest predates a
-- backdated reference-rate change. Its solved opening balance preserves the
-- row-level accrual history needed by the next repricing.
ALTER TABLE "RepaymentSchedule" ADD COLUMN "assetFinanceOpeningBalanceCents" INTEGER;
