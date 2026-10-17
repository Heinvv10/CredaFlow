Independent final edge tester: SHIP within the financial/lifecycle scope exercised below.

Source reviewed and tested: `4b2873bbbc12238edfc5af956dcc63687427d843`.
Fresh isolated clone `/tmp/cf-edge-b-final`, Node 22.23.1, own `npm ci --legacy-peer-deps`, own PostgreSQL 16 container `cf-edge-b-final-20261017`. Ran `it-db.sh check` before `prisma migrate deploy`; all migrations applied. Enumerated both live non-internal triggers and CHECK constraints (477 rows).

New committed probe `edge-b-final-cash.integration.test.ts` books/signs an operating lease and a full-maintenance lease through real services. It prepays each with two separate cash deposits, then records loss with insurance exceeding the original lease total. It independently checks conservation of all gross cash, each original deposit reference, allocated versus unapplied balances, no overpaid schedule rows, and repeated-loss refusal without duplicate insurer receipt. Both cases passed.

Real PostgreSQL results, all flags `RUN_ASSET_FINANCE_LEASE_IT=1`:

- New cash probe, `review-b-final-vat`, `lease-legal`, and `lease-tester-b`: 13 tests in four suites passed (7.63 s).
- `lease-servicing-rules-eot`, `lease-servicing-rules-end`, `lease-tester-b-historical`, and `review-b-repro`: 32 tests in four suites passed (7.53 s).
- ESLint on the new test passed.

Scope includes CPA cancellation/refund credits, loss, invoice VAT restatement, continuation/end-of-term rules, and historical event/rate controls. No new blocking defect found. This is not a production deployment, external bank settlement, fresh browser run, independent legal opinion, or a replacement for the final full CI gate. Disposable database/container and anonymous volume removed after completion.
