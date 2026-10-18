# Prepared CPA lessor cancellation assessment, 2026-10-18

The financial formula is a ceiling, not an automatic reasonable net charge.
The staff proceeds form records all ten factor findings, fairness/proportionality
under CPA s48 and clause9.10, a reasoned lower/zero amount and staff approval.
This records no bank payment. Actual completed sale proceeds are credited once;
original approved vendor costs/evidence are unchanged. An explicit immutable
noncash concession reduces collectible costs first, then gross damages. Arrears
stay separate; genuine excess goods proceeds remain a refund liability.

The quote is uniquely FK-bound to its real recovery. A new additive guard
independently recomputes PV, VAT, original costs, completed sale and per-cost-ID
collectible allocations. Existing accepted-quote immutability protects the full
assessment. The existing recovery-cost equality and CPA receipt budget need the narrow §8 exceptions
in `2026-10-18-cpa-lessor-assessment-gate-proposal.md`; the user approved the consolidated scope before the disposable PostgreSQL runs below.

A certified accepted cost allowance is exposed before proceeds application so
actual cost-only debt exists before receipt pricing even when capital is zero.
The separately stated base settlement replays without those same new costs,
preventing double counting. A guarded unique-anchor patch preserves PR A sibling
protections instead of reinstalling a stale recovery function.
Only those certified fixed costs bypass financial settlement; optional default
interest/fees remain off. Ordinary recovery ordering stays unchanged.

Verification preparation: new mathematical and replay regressions cover absent
findings, reduced/zero/ceiling charges, exact-cent VAT, genuine goods surplus,
original cost-ID concessions, and zero-capital cost-only debt plus actual receipt.
Real-PG suite `lessor-cancellation-assessment.integration.test.ts` is prepared
for genuine booked CPA leases, real recovery/valuation/sale/proceeds, no-assessment
refusal, guard mutation, lower/zero charges, actual cash/cost conservation,
immutable evidence, retry and surplus. These paths passed against a fresh migrated, owned PostgreSQL16 database after approval.

Current preparation checks: 223 focused unit/schema/panel tests pass; TypeScript,
scoped ESLint and docs/mirror checks pass. `/tmp/cf-lessor-unit-final2.log`,
`/tmp/cf-lessor-types-final2.log`, `/tmp/cf-lessor-lint-final.log`.
The cost-only receipt ordering regression failed before the certified-event
ordering fix (`/tmp/cf-lessor-unit3.log`) and passes afterward.
Those were preparation checks; approved database execution is recorded below.

Merged C/B preparation: preserve C's original earned-interest snapshots, common-law
ceiling, cancellation cutoff and permanent-stop paid history. After a permanent
stop only an immutable CPA lessor assessment accepted after the actual stop can
create new fixed cancellation costs. Same-day acceptance is ordered by the actual
acceptance/stop timestamps. Historical paid receipt shares and posting row IDs are
retained; later certified fee payments replay dynamically and ordinary forgiven
fees/interest remain zero. Defaults-off NON_NCA agreements continue contractual
interest replay even without certified costs.

Joint stop regression failed first (3 failed,1 passed): `/tmp/cf-joint-stop-red.log`.
Focused combined C/B financial tests then passed56 tests/8 suites:
`/tmp/cf-joint-combined.log`. A full joint PostgreSQL case is prepared in the
lessor integration suite: actual live-era paid charges, permanent stop, later
reasoned CPA recovery/sale with a collectible-cost concession, historical posting
IDs/paid shares unchanged, only certified new debt and real goods receipt.
The joint case now passes against PostgreSQL with the three zero/reduced/surplus cases.

Approved B-only PostgreSQL acceptance, 2026-10-18: all four lessor assessment
cases pass (`/tmp/cf-b-lessor-green.log`); all migrations applied and the owned
container/anonymous volume were removed. The first run exposed a settlement
read that hid certified new cost debt once optional charges were stopped
(`/tmp/cf-b-lessor-red.log`). A new unit reproduction failed13passed/1failed
(`/tmp/cf-b-read-red.log`); the corrected read exposes only certified new cost
postings and never attributes that debt to forgiven historical fees. The joint
oracle separately includes retained rental debt due today as well as overdue
rentals. Final read/history units:19passed/2suites (`/tmp/cf-b-read-green.log`).
No real payments, shared database, external messages or deployment were used.
A+B migration-union, browser and full local CI remain separate acceptance layers.
