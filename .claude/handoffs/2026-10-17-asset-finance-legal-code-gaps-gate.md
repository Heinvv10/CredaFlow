> **Approved by Hein 2026-10-17: specific surrender index replacement; continue goal. Work resumed.**

# Asset-finance legal code gaps — stopped at §8 migration gate

Goal: `2026-10-17-asset-finance-legal-code-gaps-goal.md`. Not complete.

## Confirmation required

Item 2 needs a WITHDRAWN surrender state. Applied migration
`20261013132000_asset_finance_s127/migration.sql:42` defines:

```sql
CREATE UNIQUE INDEX "SurrenderRequest_one_open_per_loan"
ON "SurrenderRequest"("loanId") WHERE "status" <> 'FINAL_NOTICE_ISSUED';
```

That predicate includes WITHDRAWN, so merely adding the enum value leaves a
withdrawn surrender blocking every subsequent surrender for that loan.
Proposed replacement, in a NEW migration, after adding/committing the enum
value in an earlier additive migration:

```sql
BEGIN;
CREATE UNIQUE INDEX "SurrenderRequest_one_live_per_loan"
ON "SurrenderRequest"("loanId")
WHERE "status" NOT IN ('FINAL_NOTICE_ISSUED', 'WITHDRAWN');
DROP INDEX "SurrenderRequest_one_open_per_loan";
COMMIT;
```

The replacement retains uniqueness for every live surrender and changes only
which terminal states are exempt. No table/row/column deletion is proposed.
It replaces an existing constraint, so root treated it as non-additive and
stopped under §8. SQL has NOT been applied or added as a runnable migration.
Approval requested: permit this specific index replacement and continue goal.
Guard transition, withdrawal return-of-goods evidence, routes/UI and real-PG
re-surrender test still need implementation. Do not treat this SQL as full fix.

## Repository checkpoint

Shared main checkout has existing dirty handoffs and unrelated audit files;
left intact. Fetched origin/main a740801a, confirmed #164 merged at 3a0a17e3.
No matching open asset-finance PRs at collision check.

Isolated worktrees (all based a740801a, partial/uncommitted):
- `/home/hein/Workspace/CredaFlow-legal-nca`, branch `fix/asset-finance-legal-nca`.
- `/home/hein/Workspace/CredaFlow-legal-lease`, branch `fix/asset-finance-legal-lease`.
- `/home/hein/Workspace/CredaFlow-legal-commercial` (commercial agent).
- `/home/hein/Workspace/CredaFlow-legal-rate` (rate agent).

Root changes: s125 eligibility includes NCA instalment sale and finance lease;
asset schedule split subtracts fees before principal; asset agreement cash
price/deposit/premium rows; duplicate asset Total repayable rows removed.
TDD: initial 6 failures; then 46 tests passed across nca-evidence,
s125-settlement, nca-documents, schedule-records. Initial failure log:
`/tmp/cf-legal-nca-red.log`. No real-PG/full-CI/browser/review proof yet.
No item declared closed; README list unchanged. No sample PDFs rerendered.

Item 23 research: Government Gazette 38557, 13 March 2015, regulation
23A(15)(d), page 20, explicitly includes principal debt in total cost of
credit, alongside interest, initiation fee, service fees and insurance.
Source: https://www.gov.za/sites/default/files/gcis_document/201503/38557rg10382gon202.pdf
NCR Form 20:
https://www.ncr.org.za/index.php/act/list-of-forms/category/123-english?download=480%3Aenglish
Therefore preserve shared consumer PASQ calculation. No consumer PDF pins or
`lib/compliance/pasq.ts` changed. No gate needed for that decision.

Lease partial: pure cancellation/total-loss calculations; CPA continuation
changes/tests; not fully wired or verified. No migration/commit/PR.
Other agents were instructed to stop immediately and preserve changes.
Inspect their diffs and existing test results before resuming.

No migrations applied; no real messages sent; no tenant flags changed; no
stack/deployment changes; no PRs opened or queued. Goal remains unfinished.
Node default is 20.20.2; available Node22 under ~/.nvm/versions/node; use Node22
for remaining gates. npm ci ran in isolated worktrees.

## Final agent checkpoints at stop

- Commercial: new commercial-legal.test.ts 3/3 pass after red; existing
  non-nca-charges.test.ts 7/8 (old uncapped-interest assertion still fails).
  Partial settlement/duplum/wet-ink changes, additive SuretyConsent/ISA CPA
  columns and untested migration 20261017170000_commercial_legal_guards.
  Staff consent route, CPA wiring/variant and address remain incomplete.
- Rate: sarb-effective-rates.ts 7/7 pass after missing-module red; partial
  rate-feed-sync integration uses actual MRDPRIME/MRDREPOR/MMRD855A periods,
  removes ZARONIA threshold. Borrower notice untouched; existing tests not
  updated; default history last25 points has unresolved long-outage backfill.
  Live source: https://custom.resbank.co.za/SarbWebApi/swagger/index.html
- Lease: targeted continuation runs were launched (sessions66703/58851),
  outcomes uncollected when stopped. Do not infer green.
- All agents stopped; no commit/PR/queue action by any agent.
