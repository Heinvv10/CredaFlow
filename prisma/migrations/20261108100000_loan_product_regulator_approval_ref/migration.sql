-- Kenya (KE-3): the regulator's approval reference of a loan product (the Central Bank of Kenya's
-- product approval), printed on the key facts statement. Additive and nullable: the running code
-- neither reads nor writes it, and every existing product is NULL.
--
-- Rollback: ALTER TABLE "LoanProduct" DROP COLUMN "regulatorApprovalRef";
ALTER TABLE "LoanProduct" ADD COLUMN "regulatorApprovalRef" TEXT;
