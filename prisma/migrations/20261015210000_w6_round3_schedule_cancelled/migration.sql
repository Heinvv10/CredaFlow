-- W6 review round 3: an instalment of a loan CANCELLED by an approved
-- disbursement reversal (lib/payouts/reversal-effects.ts) is CANCELLED, not
-- WRITTEN_OFF: nothing was lent, so nothing was written off. WRITTEN_OFF keeps
-- meaning a real write-off. Alone in its own migration because a value added
-- by ALTER TYPE cannot be used in the transaction that adds it.

-- AlterEnum
ALTER TYPE "ScheduleStatus" ADD VALUE 'CANCELLED';
