-- M-Pesa repayments (lib/mobile-money, KE-4): the payment method only.
-- A new enum value cannot be used in the transaction that adds it, so the table that
-- books receipts with it is in the next migration (20261108110100_mobile_money_transactions).
-- Additive: nothing the running code writes is refused.
--
-- Rollback: Postgres cannot drop an enum value. Leave it; no code writes it once the
-- next migration and its code are rolled back.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'MOBILE_MONEY';
