-- W6 review round 1: new enum values, alone in their own migration because a
-- value added by ALTER TYPE cannot be used (index predicates, CHECKs) in the
-- transaction that adds it. 20261015120100_w6_round1 uses them.

-- AlterEnum
ALTER TYPE "DisbursementPayoutStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "DisbursementPayoutStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "XeroConnectionStatus" ADD VALUE 'NEEDS_RECONNECT';
