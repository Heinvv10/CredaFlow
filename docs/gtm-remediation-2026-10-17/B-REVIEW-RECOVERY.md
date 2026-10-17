# Independent B review — recovery auditing G06-R

Reviewed immutable A submission `a6600c9d0bd5abb20c31b8367d8a4af5b0745b24`, base `527291a79909b71a17e62aa225cb81fe7791fcde`.
Verdict: approve for integration, subject to the final combined candidate gates and browser acceptance.

Reviewed all four route changes and unit/realDB tests. Issuance records an anonymous request actor (null userId/userEmail), the resolved subject and IP; it never attributes an unauthenticated request to the target account holder. Successful credential recovery records its explicit method and non-secret completion flags. No token, code, raw password or password hash enters the new audit values. The actual logAuditStrict implementation supplies null actors rather than inferring an authenticated session.

State mutation and strict audit insert share one Prisma transaction in every changed route; provider delivery follows committed issuance. Staff password, token claim and tokenVersion revocation commit together. Portal code consumption, tenant-scoped credential write and audit commit together. Guarded updateMany predicates recheck expiry/unused credential and active staff state after hashing, so a parallel claim cannot repeat the mutation. Existing lookup/rate/Turnstile/channel/tenant behavior is preserved; this does not redesign recovery token purpose or provider configuration.

The realDB tests retain the actual strict audit writer, throw after its insert and verify both credential and audit rollback, then synchronize competing resets and assert one successful consumption and exactly one committed audit. Their provider/Turnstile/rate mocks are explicit and do not claim actual delivery or challenge acceptance.

Independent verification in A's worktree: checked the four reviewed route paths had no uncommitted differences from a6600c9d, then ran `npx vitest run app/api/auth/forgot-password/route.test.ts app/api/auth/reset-password/route.test.ts app/api/portal/forgot-password/route.test.ts app/api/portal/reset-password/route.test.ts --maxWorkers=2` on Node22.23.1:4 files /63 tests PASS. Did not rerun its disposable DB suites; A's independently documented2 suites /8 actual DB cases remain submission evidence, and final MQ integration is required.
