-- A new enum value cannot be used in the transaction that adds it: the loan changes migration follows this one.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'LOAN_SETTLEMENT';
