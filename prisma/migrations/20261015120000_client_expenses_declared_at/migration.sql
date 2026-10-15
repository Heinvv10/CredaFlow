-- When the client's monthly expenses were captured (lib/credit-checks/load-facts.ts
-- declaredExpenses): monthlyExpenses defaults to 0, so without this an explicit
-- R0 declaration and expenses never captured look the same. Additive and
-- nullable: existing rows stay NULL, and a figure above 0 still counts as declared.
-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "monthlyExpensesDeclaredAt" TIMESTAMP(3);
