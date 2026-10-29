<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: ifrs9
<!-- summary: IFRS 9 stage/ECL/suspense; runs and snapshots immutable; accounting reads the MONTHLY run only -->
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
Stages every collectible loan (1, 2, 3), computes ECL = EAD x PD x LGD and the
interest held in suspense, and stores each run as an immutable `Ifrs9Run` plus
one `Ifrs9LoanSnapshot` per loan. Tender items 2.8.2/2.8.3 (Lesotho PostBank).
Design and limits: `docs/ifrs9/DESIGN.md`.

## Critical Rules
- **Integer cents and basis points.** `eclCents` is BigInt-safe, half up. The
  database re-checks ECL = EAD x PD x LGD and EAD = sum of parts on every
  snapshot (`Ifrs9LoanSnapshot_figures`); a code change to either must change
  the migration's CHECK in a new migration, never the applied one.
- **Runs are append-only** (trigger, migration `20261029121534_ifrs9`). A wrong
  run is answered by the next one. The policy and PD/LGD rows used are copied
  into the run; never recompute a stored run from today's settings.
- **Accounting reads only MONTHLY runs** (`lib/accounting/store-ifrs9.ts`), the
  latest nothing supersedes. A MONTHLY run is dated its month's last day and,
  made later, rebuilt as at that day; one original per tenant per month, made by
  `/api/cron/ifrs9-run` on the last SAST day (make-up days 1-5), or added late /
  superseded (reason, ADMIN + TOTP) while the month is open
  (`POST /api/ifrs9/runs/monthly`). ON_DEMAND is analysis and feeds nothing.
  While IFRS 9 is enabled a month cannot close without its run, nor on a run
  made before an earlier month's run was made or replaced (stale).
- **Suspension is an accounting classification.** It never changes what the
  borrower owes, the schedule, a charge or any NCA document: only the ledger
  moves interest from income to `INTEREST_SUSPENSE`. Do not read it anywhere
  borrower-facing. Stage 3 and consumer loans (`journalsSuspense`) only.
  `FULL_SUSPENSION` is the regulatory basis (suspense account, exposure net of it);
  `NET_BASIS` the IFRS 9 one (gross exposure and allowance, month's interest x
  ECL/EAD moved from income to the ECL expense, never given back). The basis
  cannot change once posted (before the first close a run on the old basis is held stale at the close and superseded).
  Reports default to the latest MONTHLY run (`loadRunReport`), never an analysis run.
- **Write-off uses the allowance** (Dr allowance / Cr bad debt); never credit
  `ECL_EXPENSE` on a write-off.
- **DPD is the product's** (`recomputeLoanBalances`, `>= 90` = Stage 3; Stage 2
  is `> 30`). Do not add a second definition.
- **A run needs the DEFAULT PD/LGD for all three stages** or it refuses; a
  missing row is never read as 0%.
- Tenant-scoped models: run inside the tenant's frame; settings, parameters and
  SICR-flag writes go through `store.ts` (audited, ADMIN + TOTP at the routes).
- Probation is calendar months from `cureStartedOn`, one stage down at a time;
  a trigger firing again resets it. Deterioration is immediate.

## Key Files
| File | Purpose |
|------|---------|
| `lib/ifrs9/staging.ts` | triggers, cure and probation (pure) |
| `lib/ifrs9/snapshot.ts` | one loan's row: EAD, suspense, ECL (pure) |
| `lib/ifrs9/run.ts` | the run: load, stage, store, audit |
| `lib/ifrs9/report.ts`, `run-report.ts`, `export.ts` | summary, transitions, XLSX |
