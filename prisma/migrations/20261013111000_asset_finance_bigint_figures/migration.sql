-- Entity financial figures in cents outgrow INT4 (max R21 474 836.47): a
-- mid-size company's turnover or asset value, and the credit-memo AFS
-- figures, are routinely above it. Widening INT4 → INT8 keeps every value;
-- the application validates inputs as whole cents <= 9e15 (below 2^53, so a
-- JavaScript number holds them exactly; lib/asset-finance/big-cents.ts).

-- AlterTable
ALTER TABLE "BusinessEntity" ALTER COLUMN "annualTurnover" SET DATA TYPE BIGINT,
ALTER COLUMN "totalAssetValue" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "EntityFinancials" ALTER COLUMN "turnoverCents" SET DATA TYPE BIGINT,
ALTER COLUMN "ebitdaCents" SET DATA TYPE BIGINT,
ALTER COLUMN "totalAssetsCents" SET DATA TYPE BIGINT,
ALTER COLUMN "totalLiabilitiesCents" SET DATA TYPE BIGINT,
ALTER COLUMN "existingDebtServiceCents" SET DATA TYPE BIGINT,
ALTER COLUMN "avgMonthlyCreditsCents" SET DATA TYPE BIGINT;
