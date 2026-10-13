-- ---------------------------------------------------------------------------
-- Hand-written (asset finance repricing, docs/asset-finance/DESIGN.md D4)
-- ---------------------------------------------------------------------------
--
-- No RepaymentSchedule trigger exemption is needed for repricing a NON_NCA
-- loan's PENDING rows: the PASQ v3 schedule guards (validateLoanPasqV3Billing,
-- validateLoanPasqV3ScheduleDates) return at once unless the application's
-- pasqVersion is 'pasq-v3', and LoanApplication_approved_status_requires_pasq
-- (20261013090000_asset_finance_foundation) requires pasqVersion IS NULL on an
-- APPROVED or DISBURSED NON_NCA application. Proven against a migrated
-- database by lib/asset-finance/reprice-loan.integration.test.ts.

-- A contract rate is either fixed or a reference plus a margin, never both and
-- never neither, and its basis says which.
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_fixed_xor_margin" CHECK (num_nonnulls("margin", "fixedRate") = 1);
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_fixed_basis" CHECK (("basis" = 'FIXED') = ("fixedRate" IS NOT NULL));
-- Annual nominal rate as a decimal (0.1275 = 12.75%).
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_resulting_rate_range" CHECK ("resultingRate" >= 0 AND "resultingRate" <= 1);
