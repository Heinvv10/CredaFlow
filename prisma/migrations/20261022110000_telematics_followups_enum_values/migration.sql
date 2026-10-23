-- A new enum value cannot be used in the transaction that adds it: THEFT is
-- added here, alone (SLICE5-FOLLOWUPS.md part T).
ALTER TYPE "TelematicsPositionContext" ADD VALUE 'THEFT';
