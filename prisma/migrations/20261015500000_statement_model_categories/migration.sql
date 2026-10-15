-- Model labels for statement rows the categoriser's rules leave UNCATEGORISED
-- (lib/statement-analysis/model-labels.ts). Additive and nullable: a read
-- without labels is categorised by the rules alone.
ALTER TABLE "StatementAnalysis" ADD COLUMN "modelCategories" JSONB,
ADD COLUMN "modelCategoriesVersion" TEXT,
ADD COLUMN "modelCategoriesAt" TIMESTAMP(3);
