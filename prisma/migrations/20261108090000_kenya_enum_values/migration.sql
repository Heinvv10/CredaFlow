-- Kenya (lib/jurisdiction, KE-0): the jurisdiction and currency codes only.
-- A new enum value cannot be used in the transaction that adds it, so the CHECKs that
-- name them are in the next migration (20261108090100_kenya_jurisdiction_currency).
-- Additive: nothing the running code writes is refused.
--
-- Rollback: Postgres cannot drop an enum value. Leave them; with the CHECKs of the next
-- migration rolled back no row can hold them.
ALTER TYPE "Jurisdiction" ADD VALUE IF NOT EXISTS 'KE';
ALTER TYPE "LenderCurrency" ADD VALUE IF NOT EXISTS 'KES';
