# KYC override policy evidence

All acceptance data is synthetic and lives only in a throwaway local PostgreSQL 16 database. No shared database, deployment, external API, real face, or real identity was used.

## Browser acceptance

The flows were exercised through an isolated local Chrome profile with native browser interactions against the seeded local app.

1. [Policy changed](01-policy-changed.png) — a TOTP-verified SUPER_ADMIN changes the per-lender policy and the card shows the audit-backed last change.
2. [Clear mismatch refused](02-clear-mismatch-refused.png) — stored similarity below `0.30` shows the non-overridable message and no exception control.
3. [Direct exception verified](03-direct-exception-verified.png) — a synthetic borderline failure is granted with single approval and the client becomes VERIFIED.
4. [Dual approval verified](04-dual-approval-verified.png) — one senior requests, a different senior approves, and the client becomes VERIFIED.

## Automated proof

- `npx tsc --noEmit`: passed.
- `npm run lint`: passed.
- `npm test`: 938 files passed; 13,356 tests passed; repository-gated suites skipped as designed.
- `bash scripts/run-integration-tests.sh`: 115 files passed, 2 expected skips; 1,136 tests passed, 2 skipped.
- `RUN_KYC_OVERRIDE_IT=1 ... override-policy.integration.test.ts`: 19/19 passed against PostgreSQL 16.
- `npm run claude-md:check && npm run agents:check`: passed; 11 generated AGENTS mirrors match.
- `npx prisma validate`: passed.
- `/review-team`, policy-breaker, and security reviewers: SHIP after fix loops.

The integration suite proves clear-mismatch write refusal and projection refusal, borderline success, complete lender-policy enforcement, self-approval refusal, hard-wall expiry, immutable decisions, exact payload binding, one-use approval, and approval/grant atomicity. It also rejects future and PostgreSQL `infinity` request timestamps.

## Mutation proof

Each guard was deliberately weakened or removed and its focused test was observed failing before restoration. Mutations covered every pure eligibility branch and boundary, the clear-mismatch write/projection guards, policy role and TOTP enforcement, request lifecycle, requester identity, exact payload binding, one-use approval, decline after policy changes, UI per-kind controls, audited lazy expiry, lock order, migration preflight, approval/grant atomicity, and future-timestamp rejection.

The final atomicity mutation disabled `KycOverrideRequest_approved_requires_grant`; the approval-only test resolved instead of rejecting. The final timestamp mutation disabled `KycOverrideRequest_guard`; a future-dated request inserted successfully instead of rejecting. Both guards were restored and the 19-test real-Postgres suite passed.

## Product calibration note

`FACE_MISMATCH_FLOOR = 0.30` is the approved product constant and is mirrored in SQL. It is intentionally documented as unmeasured because no real impostor-pair dataset exists; this work did not change either the `0.30` floor or the existing face-match threshold.
