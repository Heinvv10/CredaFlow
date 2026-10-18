-- Complete the approved TOTAL_LOSS closure rule at the existing shape CHECK.
-- Every other predicate is preserved; a loss has no physical inspection.
BEGIN;
ALTER TABLE "LeaseEndOfTerm" DROP CONSTRAINT "LeaseEndOfTerm_shape";
ALTER TABLE "LeaseEndOfTerm" ADD CONSTRAINT "LeaseEndOfTerm_shape" CHECK (
  ("outcome" = 'PURCHASE') = ("purchasePriceExclVatCents" IS NOT NULL)
  AND ("outcome" = 'PURCHASE') = ("purchaseValuationId" IS NOT NULL)
  AND ("purchasePriceExclVatCents" IS NULL OR "purchasePriceExclVatCents" > 0)
  AND ("outcome" = 'EXTEND' OR ("extensionNoticeOn" IS NULL AND "extensionEndsOn" IS NULL))
  AND ("status" = 'EXTENDING') <= ("outcome" = 'EXTEND')
  AND (("status" IN ('INSPECTED', 'INVOICED', 'COMPLETED') AND "outcome" NOT IN ('PURCHASE', 'TOTAL_LOSS'))
        = ("inspectedOn" IS NOT NULL AND "inspectedById" IS NOT NULL AND length(btrim(COALESCE("inspectionCondition", ''))) >= 3))
  AND ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
  AND ("excessUsageCents" IS NULL OR "excessUsageCents" >= 0)
  AND ("outcome" <> 'PURCHASE' OR "status" NOT IN ('INVOICED', 'COMPLETED') OR ("taxInvoiceId" IS NOT NULL AND "scheduleId" IS NOT NULL))
);
COMMIT;
