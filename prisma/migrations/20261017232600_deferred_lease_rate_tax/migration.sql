ALTER TABLE "AssetFinanceRateNotice" ADD COLUMN "taxAdjustmentPending" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "taxAdjustmentRevision" INTEGER NOT NULL DEFAULT 0;
