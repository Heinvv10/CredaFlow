# Independent C edge acceptance

Source reviewed: `02edea4853342942d68dd2354d69449ce5a5c322`.
Tester used a fresh local clone, its own Node 22.23.1/npm dependency installation,
and two independently created, fully migrated PostgreSQL 16 databases. No source
worktree edits, existing database reuse, shared data, external communications or
flag activation occurred.

SHIP for the tested cancellation, cash and spouse-consent boundaries:

- Added a booked NON_NCA instalment-sale regression with actual January 1
  cancellation recorded after a partial receipt. Before recording, contractual
  interest allocated from that cash exceeds the independently computed interest
  earned at cancellation, while the agreement remains open.
- Two simultaneous recording requests produce exactly one 201 and one 409,
  one immutable event, and no duplicate cash or write-off.
- The effective debt equals original principal plus independently prorated
  period-day earned interest less actual cash, even on a 2035 quote. Original
  contractual interest remains retained as history.
- Reversal of that existing partial receipt restores exactly the frozen debt;
  future contractual interest does not revive.
- Existing real-PG tests also exercise earlier cancellation followed by later
  possession/sale, partial sale proceeds, later receipts/reversals, immutable
  cancellation evidence, missing/late spouse consent, delayed upload of actual
  timely consent, and payout's independent database consent guard.

Both fresh runs: **2 suites, 19 tests passed**. Command after the repository's
`it-db.sh up/check`, `prisma migrate deploy` and `prisma generate`:

```sh
RUN_ASSET_FINANCE_COMMERCIAL_IT=1 RUN_ASSET_FINANCE_BOOKING_IT=1 npx vitest run lib/asset-finance/commercial-interest.integration.test.ts lib/asset-finance/payout-booking.integration.test.ts
```

Live catalog inspection confirmed eleven relevant triggers, including the
cancellation event/bound/Loan/schedule/evidence/sale guards and payout/consent
timing guards, plus three relevant CHECK constraints. Both containers and their
anonymous data volumes were removed by `it-db.sh down` after the test runs.
Scoped ESLint, TypeScript and `git diff --check` passed.

This is targeted independent edge acceptance, not full CI, a legal opinion,
production deployment evidence, or an actual bank transfer confirmation. Root
owns full CI and the separate code/security/law review decisions.
