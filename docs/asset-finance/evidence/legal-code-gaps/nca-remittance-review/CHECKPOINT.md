# NCA actual-remittance fix checkpoint — 2026-10-18

This fixes the blind-law A blocker against f2f43937. It is a review checkpoint,
not whole-PR acceptance: full CI and fresh code/security/test/law delta reviews
remain outstanding. The root confirmation gate for replacements of shared
baseline functions remains separate; this delta changes only PR-new surplus
functions and adds new enforcement objects.

## Rules and primary authority

NCA s127(6)(a): another credit provider's registered credit agreement with the
same consumer concerning the same goods routes surplus to the Tribunal.
Unrelated debts and mere provider registration do not qualify. The immutable
YES/NO determination retains its actual evidence; missing/unknown refuses.
NCA s127(6)(b): ordinary consumer remittance accompanies the post-sale statement;
an instruction alone proves neither payment nor statutory termination.
Primary source: https://www.justice.gov.za/mc/vnbp/act2005-034.pdf.

The expressly authorised §2a.6 unverified-consumer-account exception provides an
accurate statement but retains the unpaid obligation, staff notification and
statutory nontermination. Later independent release and actual external bank
execution retain the original statement and exception and provide a supplemental
confirmation. Tribunal confirmation distinguishes its distribution from consumer
termination under subsection (b). Loan COMPLETED describes settled financial debt;
it does not itself discharge an outstanding surplus. Staff/consumer views
identify the outstanding payable. All lender legal approval flags remain off.

## TDD and actual PostgreSQL evidence

- Timing red: both original defects reproduced on migrated PostgreSQL:
  instruction-only ordinary final notice accepted, pre-notice execution refused.
  `/tmp/cf-nca-remit-timing-red.log`: 2 failing tests.
- Destination red: wrong-destination execution and missing destination
  confirmation accepted. `/tmp/cf-nca-remit-destination-red.log`: 3 failures.
- Chronology/race red: raw instruction timestamp backdating accepted; pending
  proof deletion did not block execution and could leave deleted evidence.
  `/tmp/cf-nca-remit-chronology-race-red.log`: 2 failures.
- Final targeted guard proof: `/tmp/cf-nca-remit-guard-final-green.log`, 45/45
  tests across four suites. Includes wrong amount/destination, past/future date,
  server preparation timestamp, foreign/deleted proof, normalized reference
  duplicate, simultaneous execution and real lock-based proof-deletion race.
- Explicit canonical/legacy bypass and NCA receipt-reversal proof:
  `/tmp/cf-nca-remit-bypass-green.log`, 14/14 across two suites. The held s127/s131
  cases refuse legacy refund creation both through the real service and raw SQL;
  disabling only its duplicate-refund trigger admits the raw attack. Another
  mutation proves closure requires actual remittance even if the baseline
  Recovery guard is disabled.
- Earlier complete targeted regression: 92/92 across 11 suites. Broad recovery
  run identified only legacy-refund fixture conflicts; all six affected suites
  subsequently passed, 50/50. Final broad rerun is recorded separately below
  when it completes. This is not the complete integration gate.
- Final source units: `/tmp/cf-nca-remit-units-final.log`, 78/78 across 13 suites.
  Types, lint, docs-path and generated AGENTS checks pass. Read-only Prisma
  introspection reports `No difference detected`.

Only the PR-new `public.guardNcaSurplusRemittance` was refined on the already
owned disposable PostgreSQL database after the root gate was identified.
`applied-pr-new-remittance-guard.sql` is the exact applied function SQL;
`/tmp/cf-nca-remit-guard-catalog.sql` records its catalog definition. No baseline
function replacement or migration deploy was run after the root gate hold.
The final complete migration-chain rebuild remains pending approval of the
baseline-function gate. No shared database was modified.

## Preserved adversarial coverage after legacy-fixture conversion

The old `RecoveryRefund` path remains for NON_NCA. Its actor/FK, evidence
retention, amount, three-staff approval/release, reversal, tenant isolation and
concurrency mutation tests now use NON_NCA fixtures in:

- `recovery-rules-refund.integration.test.ts`
- `recovery-rules-actors.integration.test.ts`
- `recovery-rules-evidence.integration.test.ts`
- `recovery-break-tenant.integration.test.ts`
- `recovery-sale-integrity.integration.test.ts`
- The legacy refund cases in `recovery-break-money.integration.test.ts` and
  `recovery-break-round2.integration.test.ts`.

Equivalent NCA guarantees are independently retained in
`nca-surplus.integration.test.ts` and `nca-remittance-timing.integration.test.ts`:
exact amount and destination, verified recipient and three staff, foreign actor
FK and borrower evidence, case-normalized duplicate bank reference, simultaneous
execution/unique proof/audit, wrong dates, live evidence retention and deletion
race, legacy refund bypass, outstanding liability/closure and held later release.
`recovery-break-money` case 6f still uses NCA for actual proceeds-receipt reversal.
The NCA real-handler e2e now follows held statement → independently verified
account → actual bank execution → closure, rather than the superseded legacy
refund release. Its NON_NCA e2e retains the legacy refund flow.

## Browser and PDF evidence

`../nca-remittance-final-browser.json` records 43 real password/TOTP/UI events
across ordinary consumer, held then paid, and Tribunal cases. Both ordinary
notices return 409 before exact actual execution. The required destination
confirmation checkbox is exercised. Held original path/hash is unchanged and
its supplemental confirmation downloads. Each case records synthetic external
execution evidence for R940 without an extra Payment or an initiated transfer.
A harness-only fetch `status()` typo required resuming the first case's artifact
download; its successful earlier UI events remain in the evidence JSON.

The PDF samples were rerendered with coherent statutory-wait/actual-execution
dates and consumer/held/Tribunal variants. Rendered held and Tribunal PDFs were
visually inspected; text and hashes are retained in this folder. Only the
asset-finance valuation test pin changes for the Tribunal sentence; the four
shortfall-final pins and consumer NCA pins remain unchanged. Consumer PASQ is
untouched. Older instruction-first artifacts are retained under
`../nca-before-remittance-timing/` as historical evidence only.

## Remaining acceptance

- Approval of the root consolidated baseline-function replacement gate.
- Fresh complete migration chain and `npm run ci:full` on the final head.
- Fresh delta code/security/test/law team and independent edge-test SHIP.
- Any fixes from those reviews, and final PR175 exact-head/queue handling by root.

PR175 remains draft. This worker did not push, ready, queue or merge it.
