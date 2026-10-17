-- ---------------------------------------------------------------------------
-- Hand-written: the DAILY_ACCRUAL early-settlement key is receipt evidence too
-- ---------------------------------------------------------------------------
--
-- AuditLog_settlement_evidence_receipts_only (20261016200000) kept the
-- instalment-settlement evidence keys off every audit row but a receipt
-- writer's. validateLoanPasqV3Billing's DAILY_ACCRUAL branch reads
-- `earlyDailySettlement` from an audit row naming the payment, so that key is
-- held to the same rule: a receipt writer's row, or the LOAN_STATUS_CHANGED row
-- the manual-receipt path writes beside it (lib/loan/apply-payment.ts). A route
-- that audits a raw request body cannot carry it (logAuditStrict also drops it).
--
-- NOT VALID: the rule binds every row written from now on. Rows written before
-- it are not re-checked, so a database that older code wrote to still upgrades.

ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_settlement_evidence_receipts_only";

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_settlement_evidence_receipts_only" CHECK (
  JSONB_TYPEOF("newValue") IS DISTINCT FROM 'object'
  OR (
    (
      (
        "newValue" -> 'earlyInstalmentSettlement' IS NULL
        AND "newValue" -> 'contractualRows' IS NULL
      )
      OR "action" IN (
        'PAYMENT_RECORDED',
        'PAYMENT_ALLOCATED',
        'BANK_TXN_RECONCILED',
        'SMALL_BALANCE_WAIVED'
      )
    )
    AND (
      "newValue" -> 'earlyDailySettlement' IS NULL
      OR "action" IN (
        'PAYMENT_RECORDED',
        'PAYMENT_ALLOCATED',
        'BANK_TXN_RECONCILED',
        'SMALL_BALANCE_WAIVED',
        'LOAN_STATUS_CHANGED'
      )
    )
  )
) NOT VALID;
