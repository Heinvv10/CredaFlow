# Independent s131 remittance edge tests

Frozen source: `6c694e3a`, delta reviewed from `f2f43937`.
Independent clone: `/tmp/cf-edge-nca-remittance`; Node `v22.23.1`;
its own `npm ci --legacy-peer-deps` and generated Prisma client.
No implementation changes.

`lib/asset-finance/nca-s131-independent-edge.integration.test.ts` adds two
real-PostgreSQL cases under `RUN_ASSET_FINANCE_RECOVERY_IT=1`:

- An ordinary attachment instruction cannot issue the first final notice
  before actual execution. The real final-notice service refuses without
  changing status or notice metadata; the isolated deferred database guard
  must refuse the attack and admit it only when that guard is removed in a
  rolled-back mutation transaction. Exact payment then permits the real
  first final notice.
- A prepared held instruction cannot issue its first attachment notice after
  account verification, nor after release authority while still unpaid.
  Release retains the exception history; actual payment permits the notice.

Both cases also assert wrong amount/destination leave execution and evidence
rows unchanged, duplicate execution and duplicate finalisation refuse without
mutating the accepted records, one remittance exists, and surplus execution
creates no incoming loan payment.

Verification completed: Prisma generation; `npx tsc --noEmit`;
ESLint for the new suite; `git diff --check`; targeted Vitest run (11 existing
unit tests passed; the 2 new real-PG tests skipped as designed).

**PostgreSQL tests and mutation proofs: UNRUN pending §8 migration approval.**
No database/container was started, no migration or DDL was executed, and no
application server was started. This is prepared branch coverage, not a claim
of PostgreSQL success, full-gate acceptance, or browser acceptance. After
approval, use the prescribed unique disposable PostgreSQL 16 setup, migrated
with the frozen source, and enable `RUN_ASSET_FINANCE_RECOVERY_IT=1` to run the
new suite. Always tear down its uniquely named container with volumes.
