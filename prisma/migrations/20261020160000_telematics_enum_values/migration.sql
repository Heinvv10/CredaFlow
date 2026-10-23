-- Telematics (docs/asset-finance/SLICE5.md part B): a meter reading from a
-- tracker. On its own because a new enum value cannot be used in the
-- transaction that adds it (20261020160100_telematics checks for it).

-- AlterEnum
ALTER TYPE "MeterReadingSource" ADD VALUE 'TELEMATICS';
