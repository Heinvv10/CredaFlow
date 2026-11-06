-- Kenya (KE-3): the regulator's approval reference of a loan product (the Central Bank of Kenya's
-- product approval), printed on the key facts statement. Additive and nullable: every existing
-- product is NULL, and the code that ships with it writes it only through the two-person product
-- change outside the NCA and reads it only for {{product.regulatorApprovalRef}}. No CHECK or trigger.
--
-- Rollback: ALTER TABLE "LoanProduct" DROP COLUMN "regulatorApprovalRef";
ALTER TABLE "LoanProduct" ADD COLUMN "regulatorApprovalRef" TEXT;
