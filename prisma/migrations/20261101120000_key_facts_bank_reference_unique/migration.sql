-- A10b. A manual key-facts payout records the bank's reference of a transfer already made: one transfer pays one loan.
-- Partial and on an expression, so Prisma does not model it; a South African application is not touched.
CREATE UNIQUE INDEX "LoanApplication_key_facts_bank_reference"
  ON "LoanApplication" ("tenantId", lower("disbursementRef"))
  WHERE "disclosureRegime" = 'KEY_FACTS'::"DisclosureRegime" AND "disbursementRef" IS NOT NULL;
