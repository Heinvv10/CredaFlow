-- A5b: new enum values, alone in their own migration because a value added by ALTER TYPE cannot be used (CHECKs, index
-- predicates) in the transaction that adds it. 20261101140100_product_types uses them.

-- AlterEnum
ALTER TYPE "RepaymentStructure" ADD VALUE 'BALLOON';

-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'SALARY_BACKED';
ALTER TYPE "ProductType" ADD VALUE 'SME';
ALTER TYPE "ProductType" ADD VALUE 'GROUP';
ALTER TYPE "ProductType" ADD VALUE 'REVOLVING';
