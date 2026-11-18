# Asset-finance legal-code gaps — complete

Completed 18 October 2026. All six success criteria in
`2026-10-17-asset-finance-legal-code-gaps-goal.md` are satisfied.

## Merged source and queue evidence

Final main: **e09956d5d4fcbc0c9d1d68a4f6ad9f8985e66b08**.
Its complete tree exactly equals the tested final candidate
**cb0ae9d90f36c40dd77234eb94081a4302dfdc13** (`git diff --exit-code`).
Reviewed A, B and D heads are all ancestors of main.

| Scope | PR | Reviewed final head | Merge evidence |
|---|---|---|---|
| Commercial/surety C | [176](https://github.com/Heinvv10/CredaFlow/pull/176) | 03b2d1a3 | MQ merge45609da5895d51b8d91df12348c3c47ffbbb6bb1 |
| NCA A | [175](https://github.com/Heinvv10/CredaFlow/pull/175) | c39f04a83fac32c5c542896a505c1ae2c3502cbb | Included through final D; GitHub merged=true, recorded merge50cc225d7cbc985a540167a2ecf11c12f58a4c37 |
| CPA/lease B | [174](https://github.com/Heinvv10/CredaFlow/pull/174) | d3ed6f8b580b239c384b22a99dfa475e59e2650c | Included through final D; GitHub merged=true, recorded merge35cd5dc53bfd56983122b24d47a8008f33129d67 |
| Rates/notices/integration D | [177](https://github.com/Heinvv10/CredaFlow/pull/177) | cb0ae9d90f36c40dd77234eb94081a4302dfdc13 | MQ mergee09956d5d4fcbc0c9d1d68a4f6ad9f8985e66b08 |

`mq add 175 174 177` ran together at06:36:07UTC. MQ selected the green,
current-main-integrated D head, merged it at06:37UTC, and GitHub marked its
included A/B PRs merged as their heads became reachable. MQ then removed A/B
from the queue. No extra batch PR was necessary. Queue and in-flight state
are empty. No direct/manual merge bypass was used.

Unrelated PR178 landed first through MQ. D incorporated its ten StatementAI
access-control/UI/tests/docs files in a clean merge, independently reviewed as
disjoint from legal, financial, rate and schema changes.

## Success criteria and acceptance

1. All26 rules have code/server or database enforcement and regression evidence.
   The committed [rule-to-test matrix](https://github.com/Heinvv10/CredaFlow/blob/e09956d5/docs/asset-finance/evidence/legal-code-gaps/ACCEPTANCE.md)
   maps each original item to its real-PG/unit/render tests. Committed independent
   repros include proof-deletion race orders, s131 remittance, floor boundaries
   and amended-rental projection/CPA cancellation checks.
2. The legal-wording README implementation-gap list is empty. DESIGN records
   the dated legal basis for changes; module notes are updated.
3. Both legal sample renderers were rerun and reproduced the committed PDFs.
   Consumer PASQ output and consumer NCA fingerprint/pin files are unchanged.
   The asset valuation document pin change has retained before/after text proof.
4. Password/TOTP browser acceptance and screenshots cover NCA valuation/wait/
   withdrawal/sale/remittance and s125 settlement; CPA unilateral cancellation,
   goods credit and monthly continuation; surety payout/e-sign refusals. The
   final lease recheck exercised five actual POST actions, no page errors,
   evidenced TOTAL_LOSS closure and conserved cash. Screenshots and browser
   scripts/results are committed under `docs/asset-finance/evidence/legal-code-gaps/`.
5. Every PR passed full local/hosted gates and independent code, security, tests
   and South African law review; fixes returned to review until SHIP. Independent
   edge testing used its own clone/install and fresh migrated PostgreSQL.
   All PRs are merged through MQ as described above.
6. This handoff is written. The authorized memory update is recorded through
   an extension note, superseding the earlier pending confirmation checkpoint.

The committed [review register](https://github.com/Heinvv10/CredaFlow/blob/e09956d5/docs/asset-finance/evidence/legal-code-gaps/REVIEW.md)
records review scope and proof limits. Final test-only legacy-assessment inputs
and CI-only adjustments also received independent CODE/TESTS SHIP. No financial
assertions were changed to make a gate green.

## Final verification

| PR | Final local full CI | Hosted quality and integration |
|---|---|---|
| C176 |19,720 units;2,945 PG |[39075056843](https://github.com/Heinvv10/CredaFlow/actions/runs/39075056843) SUCCESS |
| A175 atc39 |19,759 units;14 model checks;2,998 PG |[39099605632](https://github.com/Heinvv10/CredaFlow/actions/runs/39099605632) SUCCESS |
| B174 atd3ed |19,797 units;14 model checks;3,024 PG |[39100178161](https://github.com/Heinvv10/CredaFlow/actions/runs/39100178161) SUCCESS |
| D177 atcb0 |19,864 units;14 model checks;3,081 PG |[39103445503](https://github.com/Heinvv10/CredaFlow/actions/runs/39103445503) SUCCESS |

Every local full gate includes root/demo TypeScript, ESLint, docs/date checks,
complete unit suites, production build and migrated disposable PostgreSQL.
Final D PostgreSQL:362 suites passed,2 explicit opt-in suites skipped;3,081 tests
passed,3 skipped. Hosted D units:19,861 passed (three additional environment
skips),14 model checks and the full3,081 PG passed. Local exact-head exit0 is
retained in `/tmp/cf-d-timeout-final-full.exit`; full log is the corresponding
`.log`. Hosted final log: `/tmp/cf-d-final-hosted.log`.

Two gate failures were fixed with retained evidence rather than hidden:

- Cold root TypeScript and Next's independent TypeScript worker exceeded4GiB.
  Independent Node22.23.1 cold runs reproduced both OOMs; both passed at6GiB.
  Root types/build now default to6144MiB, demo remains4096, explicit caller
  NODE_OPTIONS survives, and no compiler checks/exclusions were removed.
  `rate/TYPECHECK-HEAP.md` retains measurements and version differences.
- The60-row PASQ repricing/receipt/reversal integration scenario exceeded the
  default five-second test limit. Only its existing two-case family now has a
  bounded30-second timeout. All fixtures, money assertions and independent
  oracles are unchanged. Fresh independent cases passed4.006s/1.337s; the full
  hosted run passed5.956s/1.631s. `rate/PASQ-INTEGRATION-TIMEOUT.md` records it.

The separately opted-in Docker PDF image/lender-build suites are not part of
ci:full and were not run. Statement-reader accuracy is explicitly not measured
by its skipped fixture. These are not represented as passed acceptance.

## Approval boundaries and cleanup

Hein explicitly approved the consolidated additional non-additive migration
scope. The frozen inventory and proposals remain in the companion handoffs.
All DDL/testing here used owned disposable databases; no shared DDL was applied.

No deployment, demo/Fairscore mutation, real payment/message, new paid service
or lender legal-approval flag activation occurred. This proves synthetic code
acceptance. Lender legal approval of its rendered documents remains required
before enabling `assetFinanceLegalWordingApproved`.

Goal-owned A/B/C worktrees and D integration worktree, consent worktree and
merged branches are removed. Owned review/browser scratch clones and disposable
PostgreSQL containers/volumes are cleaned. Shared dirty local main remains at
93f28b01; its unrelated edits and dirty LATEST are preserved. Read origin/main
or the immutable links above for the merged source; this shared local checkout
was intentionally not reset or fast-forwarded.
