# Legacy recovery acceptance assessment, 2026-10-18

Parent D candidate: d53a977f. Full CI exposed three historical recovery tests
calling the proceeds route without the now-required CPA lessor assessment:
REC-NV-2 in two suites and REC-NC-1 in the eight-deal suite. Fresh owned
PostgreSQL16 reproduced all three HTTP409 responses with the actual error
`A case-specific lessor cancellation assessment is required`.
`/tmp/cf-legacy-recovery-red.log`: 3 failed,9 passed.

These synthetic legacy accounts contain only their fixed already-earned
settlement claim, with no unearned LeaseRental rows. Their actual financial
ceiling is zero. The test now explicitly demonstrates omitted-assessment refusal,
no cash mutation, officer refusal and an administrative reasoned zero net
assessment with all ten factor findings. It verifies the accepted assessment's
zero PV/ceiling and preserves all actual approved recovery-cost rows.

The original independent eight-deal amounts remain unchanged: actual proceeds,
payment, shortfall/surplus, cost totals and VAT. In REC-NC-1 the actual 3795000-cent
cost remains fully collectible because actual net goods 19482498 cents cover it;
the assessed new net charge remains zero. No artificial expense concession,
receipt or bank movement is created. REC-NV-2 retains its 19509568-cent surplus
and its original actual refund workflow assertions.

Both actual route suites pass 12 tests after the test-only change:
`/tmp/cf-legacy-recovery-green.log`. No production source, fixture classification,
shared database or legal-approval flag changed. The database was disposable and
owned by this repair; TypeScript and scoped ESLint checks accompany the commit.
