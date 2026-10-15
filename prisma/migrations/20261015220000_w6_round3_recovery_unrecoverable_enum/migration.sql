-- W6 review round 3 (accounting review): a recovery case can be closed as
-- unrecoverable (lib/payouts/recovery.ts). Alone in its own migration: a value
-- added by ALTER TYPE cannot be used in the transaction that adds it, and
-- 20261015220100 compares against it.

-- AlterEnum
ALTER TYPE "PayoutRecoveryStatus" ADD VALUE 'UNRECOVERABLE';
