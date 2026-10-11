-- A loan application must request a positive amount (cents). Only application
-- code enforced this; the database accepted 0 and negative values. Validated
-- (not NOT VALID): no production path writes a non-positive appliedAmount, and
-- a row that did would fail this migration rather than slip through.
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_appliedAmount_positive" CHECK ("appliedAmount" > 0);
