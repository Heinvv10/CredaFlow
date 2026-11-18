# Asset-finance legal code gaps — review/fix checkpoint

Goal: `2026-10-17-asset-finance-legal-code-gaps-goal.md`. **Not complete.**
User approved the consolidated additional migration scope on 2026-10-18; execution resumed. Preserve the
shared checkout's dirty LATEST.md and unrelated handoffs/audit files.

## Approval boundary

The existing approval is expressly for the surrender partial-index replacement
only. Further non-additive proposals are consolidated, with exact SQL, in
`2026-10-18-legal-nonadditive-migration-inventory.md`. Additional proposals:
`2026-10-17-legal-zero-rental-gate.md` and
`2026-10-18-lease-total-loss-gate-proposal.md` and
`2026-10-18-cpa-lessor-assessment-gate-proposal.md`.

User explicitly replied “approved. cont” to the consolidated proposal on 2026-10-18.
This authorizes its listed migrations, including CPA assessment, total-loss
closure and zero-rental enforcement, with code and verification.
No shared database was changed. Earlier proposed baseline replacements were
tested in disposable databases before the scope audit; that testing does not
supply approval. The approved baseline replacements may now be tested and shipped with their code. Refinement
of PR-new objects on an existing owned disposable DB is permitted independently.
The zero-rental CHECK is still unchanged. No real message/payment, deployment,
stack change, legal-approval activation or spending is authorized.

## Proven independent slice C

PR #176: https://github.com/Heinvv10/CredaFlow/pull/176
Head `03b2d1a3b44ceb1648ac71de847fcb4e9a3011a2`.
All four genuinely blind reviewers (`fork_turns:none`) returned SHIP within
their roles. Independent edge tests and browser screenshots are committed.
Exact-head root `ci:full` passed: 19,720 units, 2,945 PostgreSQL tests,
336 PG suites passed and 2 opt-in suites skipped. Build/types/lint/docs/date
gates also passed. Log `/tmp/cf-commercial-midnight-ci.log`, exit file 0.
Hosted run `39075056843` passed: 19,717 units (environment-dependent skips),
2,945 PG tests. Merged through mq as `45609da5895d51b8d91df12348c3c47ffbbb6bb1`
at 22:43:17 UTC. Fetch and merge-base verification proved reviewed head03 is
the second parent and an ancestor of origin/main. Own clean commercial worktree, local branch and remote branch were removed
after ancestry verification. Shared main was not checked out/reset.

## A — actual NCA surplus remittance

PR #175 remains DRAFT, published at `f2f43937`, unqueued. Its old full CI
was green, but blind law correctly blocked missing actual-payment timing and
same-consumer/same-goods registered-agreement/Tribunal handling.
Current clean local head: **0a0db993**, implementation through **6c694e3a**.
Actual bank proof precedes ordinary notice, unknown competing agreements refuse,
Tribunal destination is explicit, and a truthful no-verified-account exception
preserves unpaid liability. Later payment retains original statement/hash.
Preparation timestamps, exact destination/amount, live retained proof and
proof-deletion locks are enforced. No fake incoming Payment is created.
Consumer PASQ/pins are unchanged; asset valuation pin has text-difference proof.

Scoped code/security/law/tests fix reviews returned SHIP within their scopes.
Evidence: `docs/asset-finance/evidence/legal-code-gaps/nca-remittance-review/CHECKPOINT.md`.
Broad recovery: 471 pass / 3 expected skips; final narrow 32 PG/history and
80 unit/portal/PDF/history passes. Browser: 43 real password/TOTP/UI events,
three consumer/held/Tribunal cases. These overlapping runs are not summed.
Only PR-new functions were refined on the existing owned disposable DB after
the baseline hold; that DB and volume have since been removed.
Independent two-case s131 writer/deferred-trigger probe is committed at 0a,
with 11 supporting units/type/lint green, but those two new PG cases are UNRUN.
Fresh migrated full CI and main-C integration remain held.

## B — CPA assessment, total-loss closure, permanent-stop union

PR #174 remains DRAFT, published at `f33bb33c`, unqueued. That old exact-head
full CI passed 19,701 units / 2,951 PG tests; it does not validate new fixes.
Current clean local head: **2c1138f8**, production implementation **9be910f3**.
Includes merged C/main `45609da5`, consumer Reg5 assessment, lessor net CPA
assessment with ten factors/reasons, and retained vendor cost/BANK evidence
plus noncash collectible-cost concessions. Two exact guardRecovery anchor
patches preserve installed A protections and adjust costs AND expected receipt.
No stale whole guardRecovery replacement is introduced by that concession.

TOTAL_LOSS closure does not invent return/inspection or restock an asset;
maintenance refunds need actual retained bank proof. Fund→proof locks and both
proof-deletion race orders are prepared. New closure/lessor SQL was NOT applied.
Consumer assessment had earlier actual PG red→12 green plus 41 units; new
lessor/closure PG cases remain UNRUN.

Joint B/C fix preserves actual permanent charge stops even with optional fees
off, frozen historical posting IDs and paid shares, and only replays later
certified costs/receipts. Independent code/law/security scoped reviews SHIP;
joint code reviewer ran 35 tests and supplied independent arithmetic probes.
Focused union 57 tests/9 suites passed; broad unit run 1,882 pass / 1,112 skips.
Types/lint/docs/mirrors passed. Independent 420-case arithmetic and 36-case
partial-payment/reversal probes are committed (c63233da, 2c1138f8).
Logs: `/tmp/cf-joint-grid-final.log`, `/tmp/cf-joint-broad-unit2.log`,
`/tmp/cf-joint-independent-final.log`. Actual B-only/A+B guard union,
new real-DB flows, browser and exact-head full CI remain held/unproven.

## D — repricing, durable notices, zero-rental floor

Current head **652ed578**, including floor implementation **f4e03e54** and
independent 324-scenario arithmetic probe **f028bca8**.
Earlier actual booked OL-cut/FML-rise PG oracles passed before the hold.
Stale dispatch outcomes/completion now CAS tax revision; capital replay uses
rental cash excluding VAT/maintenance. Deadline is actual effectiveness plus
30 SA business days, durable authenticated cron dispatch/escalation even when
feature off. Historical completedAt is NOT fabricated as dispatch evidence.

OL/FML floor is zero; residual stays lessor property. Whole-cent funding and
lessor rounding difference are explicit. Historical credits use original
supply tax; maintenance/actual cash survive; manual refunds remain pending.
No zero-value invoice is created. Final closure follow-up 652ed578 ignores
uninvoiced zero-consideration rows while retaining positive maintenance gating:
regression failed first, then 13 tests/4 suites, types and lint passed.
Logs `/tmp/cf-rate-floor-billing-{red,green,types,lint}.log`.
Prior floor code/law/security scoped static reviews SHIP; narrow closure delta
CODE review also returned SHIP (independent 4 suites / 11 tests). Independent math probe passed locally.

Four actual-booked OL/FML/VAT floor PG cases, three final notice/deadline
regressions and final union/full CI/browser remain UNRUN. The zero-rental CHECK
is unchanged and no runnable replacement was added. No new PG/DDL after hold.
No D PR exists yet. See committed `rate-and-notices.md` for evidence boundaries.

## Resumption

Node 22: `/home/hein/.nvm/versions/node/v22.23.1/bin`. Each worktree/clone owns
its npm install (`npm ci --legacy-peer-deps`) and generated Prisma client.
Use unique disposable PG names/ports and cleanup `docker rm -fv`.
Old gh cannot edit bodies via GraphQL ProjectsClassic; use REST PATCH with
`-F body=@/tmp/file`. Only mq merges PRs. Check current main/head/queue live.

Final goal acceptance, handoff/memory completion and cleanup remain unfinished.
Do not mark the goal complete. `/tmp/cf-asset-legal-review-status.json` is an
additional checkpoint but may lag current owner commits; verify live state.

Final checkpoint: all A/B/D worktrees clean; mq empty; remote PR174/175 still
drafts at their old published heads. Removed remaining owned disposable PG
containers `cf-it-commercial-cap-20261017` and `cf-it-legal-nca-20261017` with
their anonymous volumes. Unrelated running stacks were left untouched.
