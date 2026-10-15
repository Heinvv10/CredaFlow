-- Statement insights (goal 2026-10-14 §2a.5): the one approved schema change.
-- An additive enum value for the EXPENSE_UNDERSTATED check
-- (lib/credit-checks/expense-understated.ts). Every OPEN flag of any check is
-- already held by LoanApplication_a0_guard_open_check_flags, so no trigger or
-- constraint changes with it.
ALTER TYPE "CreditCheck" ADD VALUE 'EXPENSE_UNDERSTATED';
