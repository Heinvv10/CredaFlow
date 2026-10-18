-- Approved 2026-10-18 under legal-code-gaps goal §8.
-- A historical rate cut may exhaust rental consideration; maintenance remains due.
BEGIN;
ALTER TABLE "LeaseRental" DROP CONSTRAINT "LeaseRental_amounts";
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_amounts" CHECK (
  "periodNo" >= 1
  AND "rentalExclVatCents" >= 0
  AND "maintenanceExclVatCents" >= 0
  AND "vatCents" >= 0
  AND "totalCents" = "rentalExclVatCents" + "maintenanceExclVatCents" + "vatCents"
  AND "vatRate" >= 0 AND "vatRate" < 1
);
COMMIT;
