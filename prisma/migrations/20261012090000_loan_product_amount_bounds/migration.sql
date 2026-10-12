-- A loan product's amount range (cents) must be positive and not inverted.
-- Only the products API enforced this (lib/product-config/bounds.ts); the
-- database accepted a zero or negative minimum and max < min. Validated (not
-- NOT VALID): a database that already holds a violating product fails this
-- migration until that product is fixed. min = max is allowed (MICRO30 style).
ALTER TABLE "LoanProduct" ADD CONSTRAINT "LoanProduct_amount_bounds" CHECK ("minAmount" > 0 AND "maxAmount" >= "minAmount");
