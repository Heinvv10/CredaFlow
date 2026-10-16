# F3 credit notes: mutation run

Each mutation was applied to the code at commit `7c9c4af4`, the suites below were run against a
disposable PostgreSQL 16 (`scripts/it-db.sh`, `RUN_ACCOUNTING_IT=1 TENANT_RLS=on`), and the file was
restored with `git checkout` before the next one. Baseline at `7c9c4af4`: IT 6/6 passed, unit 56/56
passed.

- IT: `lib/accounting/asset-finance-credit-notes.integration.test.ts` (6 tests)
- Unit: `lib/accounting/sources-asset-finance.test.ts` + `lib/accounting/sources-asset-finance-credit-notes.test.ts` (56 tests)

| # | Mutation | IT | Unit | Caught by |
|---|---|---|---|---|
| M1 | Inception credit note: its VAT goes to `AF_PRICE_CREDITS` instead of `OUTPUT_VAT` | 4 failed | 4 failed | `AF_OUTPUT_VAT` control; hand-worked vectors |
| M2 | Inception credit note credits `LEASE_DEBTORS` instead of `AF_INSTALMENT_DEBTORS` | 3 failed | 5 failed | hand-worked vectors (the tie sums every receivable role, so only the exact vector sees this) |
| M3 | Inception credit note no longer waits for the payout's release | 6 failed | 1 failed | July posts the early credit (mapping refusal, then the tie and the control) |
| M4 | Sale credit note drops its `OUTPUT_VAT` line (clearing takes the VAT-inclusive value) | 2 failed | 2 failed | `AF_OUTPUT_VAT` and `RECOVERY_RESULT` controls; vectors |
| M5 | Sale credit note debits `RECOVERY_RESULT` instead of `RECOVERY_CLEARING` | 2 failed | 2 failed | hand-worked vectors (the result total is unchanged) |
| M6 | Independent book subtracts credit notes for leases only (old `AND l.lease`) | 4 failed | not covered by unit | `RECONCILIATION_FAILED` from August |
| M7 | Output VAT control counts an inception credit note before the payout's release | 5 failed | not covered by unit | `AF_OUTPUT_VAT` in July (`JRN-IS-CN-EARLY`) |
| M8 | Output VAT control drops the buyer-invoice credit notes branch | 2 failed | not covered by unit | `AF_OUTPUT_VAT` in October and November |
| M9 | Result control drops the buyer-invoice credit notes' excl. VAT value | 2 failed | not covered by unit | `RECOVERY_RESULT` in October and November |
| M10 | Loader passes no credit notes for the sale invoice | 2 failed | not covered by unit | `AF_OUTPUT_VAT` / `RECOVERY_RESULT`; vectors |

Every mutation turned at least one suite red; after each restore the tree matched the commit.
"Not covered by unit": the unit suites read the fixtures directly, never the SQL or the loader, so only the IT can see it.

## Round 2 (review): finance lease and the explicit release gate

Applied to commit `e1c909ed`, which adds `JRN-FL-CN` (finance lease) and `JRN-IS-CN-WO` (credit note after a write-off) and
gates the independent book's credit notes on the payout's release explicitly. Baseline: IT 6/6, unit 61/61. Same suites and
procedure as above.

| # | Mutation | IT | Unit | Caught by |
|---|---|---|---|---|
| M6 | M6 re-run on the new CTE: credit notes for leases only | 4 failed | not covered by unit | `RECONCILIATION_FAILED` from August |
| M6b | Drop the explicit release gate from the book's `cred` CTE | passed | not covered by unit | Not caught, by construction: the book already leaves out an instalment sale whose payout is not released (its final `WHERE`), so the explicit gate states that rule where the credit is summed and cannot change a figure |
| M11 | Loader passes no inception credit notes for a finance lease | 2 failed | not covered by unit | `RECONCILIATION_FAILED` in September: AF-FL-CN01 journal 2 033 200, owed 1 975 700 |
| M12 | Sources skip a finance lease's inception credit notes | 2 failed | 2 failed | the tie and the controls in September; hand-worked vectors |
| M13 | The VAT controls treat only an instalment sale's first invoice as an inception invoice | 5 failed | not covered by unit | `AF_INPUT_VAT` from July (the finance lease's inception VAT) |
