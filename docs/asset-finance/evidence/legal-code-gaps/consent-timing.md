# Spouse consent chronology — 17 October 2026

MPA s15(2)(h) requires witnessed spouse consent before becoming surety;
s15(4)'s subsequent ratification provision excludes paragraph (h). Staff
record both actual signature dates from the retained documents and attest
to the order of signatures, including when both signatures share a date.
Upload, confirmation and verification timestamps do not stand in for execution.
Suretyships use wet ink, so their `DealSigner.signedAt` is intentionally null.

The additive migration adds nullable actual dates and a false-by-default
attestation. It invents no historical dates. Existing evidence without this
timing remains retained but cannot pass a new payout gate. Consent after
surety execution, future execution, execution after upload, missing timing
and a missing attestation fail the database guard. The payout guard checks
timing independently, including legacy records. Confirmed surety scans are
already immutable under `DealSigner_guard`.

Late recording of actual earlier consent is allowed. The staff identity,
recording timestamp and old/new actual dates are audited. The form explains
that subsequent consent cannot ratify an existing suretyship; it does not
provide a bypass. A new lawful execution requires a new signing process.

Verification in an isolated worktree with Node 22 and disposable PostgreSQL16:

```
npx prisma generate
bash scripts/it-db.sh check
npx prisma migrate reset --force --skip-seed --skip-generate
RUN_ASSET_FINANCE_BOOKING_IT=1 npx vitest run lib/asset-finance/payout-booking.integration.test.ts
npx vitest run lib/asset-finance/surety-consent-timing.test.ts lib/asset-finance/payout.test.ts lib/asset-finance/commercial-legal.test.ts
npx tsc --noEmit
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema --exit-code
```

The focused timing suite first failed all four original cases without the
implementation (`/tmp/cf-consent-unit-red.log`). The real payout suite passes
14 tests. Its chronology attacks mutate only the target trigger and prove
that each otherwise-refused write then succeeds in a rolled-back transaction.
It also exercises the real route, direct server helper, an independently
blocked legacy payout and the allowed late-recording case. The migrated
schema reports no difference. Full quality/integration and final independent
reviews belong to the enclosing PR acceptance record.
