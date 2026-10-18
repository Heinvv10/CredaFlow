# Scoped PASQ integration timeout

Parent candidate: `79d859f1`.

The hosted integration run passed 3080 tests but the 12-paid-period case in
`reprice-nca-pasq.integration.test.ts` exceeded Vitest's default 5000 ms limit.
The failure was `Test timed out in 5000ms`, with no financial assertion failure.
The retained coordinator log is `/tmp/cf-d-next-hosted-integration.log`, lines
2303–2328. This is a timeout diagnosis, not a claim that the hosted gate passed.

The single existing `it.each([12, 59])` now has an explicit 30-second timeout.
No global timeout, fixture, assertion, financial oracle, production code or
compiler configuration changes. The case builds 60 monetary rows and real paid
receipts, reprices the acknowledged PASQ, and verifies fees, premiums, immutable
history and exact balances. The 12-period path additionally settles, corrects,
reverses through the HTTP route, checks the independent daily funding oracle,
checks idempotency and resumes repricing. All those checks remain intact.

Independent validation used an isolated clone with its own dependencies and
regenerated Prisma client, then `it-db.sh up` with unique container
`cf-it-tests-edge-pasq-1792304100-2584214`, `check`, and `prisma migrate deploy`.
The suite ran with `RUN_ASSET_FINANCE_REPRICE_IT=1` and
`vitest run --no-file-parallelism --reporter=verbose`.

| Paid periods | Result | Measured test time |
| --- | --- | --- |
| 12 | Passed | 4006 ms |
| 59 | Passed | 1337 ms |

Both tests passed, no skips; total test time 5.35 s, suite duration 7.11 s.
The container and anonymous volume were removed by `it-db.sh down` even if a
prior step failed. Scoped ESLint and `git diff --check` passed. Evidence log:
`/tmp/cf-tests-edge-pasq-run.log`. A full hosted rerun remains the coordinator's
gate; no database or external action outside this disposable synthetic test ran.
