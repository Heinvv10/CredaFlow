# IFRS 9 staging, ECL and interest suspension

Tender LPB/0009/2026 items 2.8.2 (staging, SICR, ECL, loan classification and
reports) and 2.8.3 (automatic suspension of interest on non-performing loans).
Code: `lib/ifrs9/`, `prisma/schema/ifrs9.prisma`, accounting hooks in
`lib/accounting/sources-ifrs9.ts` and `store-ifrs9.ts`.

## Staging (`lib/ifrs9/staging.ts`)

| Stage | Trigger (any) |
|---|---|
| 3 | DPD >= `defaultDpd` (90); status DEFAULTED or PENDING_WRITE_OFF; collections stage ATTORNEY_REFERRED (legal); RESTRUCTURED or s86 debt review when the lender maps them to Stage 3 |
| 2 | DPD > `sicrDpdOver` (30); an active SICR flag (bureau / behaviour downgrade, watchlist); RESTRUCTURED and s86 debt review (by default, per `restructuredStage` / `debtReviewStage`, 1 = no effect) |
| 1 | none of the above |

IFRS 9 B5.5.19 says "more than 30 days past due" and B5.5.37 says default "no later
than when 90 days past due"; the product's PAR90/NPL is `>= 90` everywhere, so
Stage 3 starts at 90, not 91. The tender brief's ">90" was read as that definition.

Deterioration is immediate. Improvement waits out a probation per stage
(`stage3ProbationMonths` default 6, `stage2ProbationMonths` default 3), counted in
calendar months from the first run whose triggers were clear, one stage at a time.
A loan that was RESTRUCTURED serves the longer of its stage's probation and
`restructuredProbationMonths` (default 12) after the status ends; the snapshot's
reasons carry `RESTRUCTURED` / `RESTRUCTURE_PROBATION` so the next run knows.

The cure clock belongs to the trigger stage being left. A trigger at or above the
loan's own stage restarts it. A Stage 3 loan whose default triggers have cleared but
which is again over the SICR threshold (say 40 days past due) does **not** restart
the Stage 3 clock: the default is cured, so after `stage3ProbationMonths` it steps
down to Stage 2, not 1. (Policy choice; pinned in `staging.test.ts`.)

All thresholds are per lender (`Ifrs9Config`), validated in `settings.ts` and by CHECK.

## ECL

`ECL = EAD x PD x LGD`, cents and basis points, rounded half up (BigInt). PD is the
12-month PD for Stage 1 and the lifetime PD for Stages 2 and 3, as the lender enters
it; a Stage 3 PD must be 100% (validation and CHECK). `Ifrs9EclParameter` rows are
`(scopeKey, stage)`; scope is `PRODUCT:<id>`, then `CONTRACT:<type>`, then `DEFAULT`,
most specific first. The DEFAULT row must exist for all three stages (a run refuses
otherwise). Snapshot money columns are `Int` cents like `Loan.principal` and
`totalRepayable`, so a loan cannot exceed R21.4M anyway; run totals are BigInt.

EAD = outstanding principal + unpaid raised interest and fees + default charges owed
+ interest accrued since the last due date (pro rata by day), less interest in suspense
on the full-suspension basis (below).

## Interest in Stage 3: two bases, one setting

`stage3InterestBasis` (default `FULL_SUSPENSION`). Only a Stage 3 loan is ever
suspended (`suspensionDpd` is validated never to be below `defaultDpd`; with
`suspendOnStage3` on, every Stage 3 loan including its probation; off, only those at
`suspensionDpd`), and only a consumer loan (`contractType LOAN`): asset-finance
interest stays in income, so for those contracts nothing is taken out of exposure.

- **`FULL_SUSPENSION` is the regulatory / prudential basis** (the tender's 2.8.3, "automatic
  suspension of interest on non-performing loans", and the usual central-bank NPL rule). All the
  raised, unpaid contractual interest and the default interest owed are held in suspense, none further
  accrues into exposure, and none of it is provisioned.
- **`NET_BASIS` is the IFRS 9 basis** (5.4.1(b): for a credit-impaired asset, interest revenue is the
  effective interest rate on the amortised cost *net of the allowance*). Exposure stays gross; the
  share of the raised, unpaid interest that the allowance covers, ECL / EAD, is suspended. The
  contractual rate is the proxy for the effective interest rate (no EIR is computed). Interest already
  collected is not reversed.

A lender that reports to a central bank on the prudential basis and to its auditors under IFRS 9 keeps
`FULL_SUSPENSION` for the regulatory return; which basis the **financial statements** use is its auditor's
call, and the choice is the lender's, not the product's. In the ledger (both bases) the suspended amount
moves `INTEREST_INCOME` / `DEFAULT_INTEREST_INCOME` -> `INTEREST_SUSPENSE`; as it is collected, or the loan
cures, the figure falls and the next month's delta puts it back into income. On write-off it reduces
`BAD_DEBT_EXPENSE`. The borrower's balance, schedule, charges and every NCA document are unchanged.

## Runs, snapshots, accounting

`Ifrs9Run` + `Ifrs9LoanSnapshot` are append-only (trigger) and carry the policy and parameters used.

- **ON_DEMAND**: describes today, analysis only. It never feeds the ledger, a later stage or a report's
  default. `POST /api/ifrs9/runs { kind: "ON_DEMAND" }` is the only run the manual route makes.
- **MONTHLY**: the month's official run, always dated the month's **last day** and, when made later, rebuilt
  as at that day (days past due, paid amounts and outstanding principal from the receipts live before the
  day ended, `lib/reports/book-as-of.ts`). Made by the cron `ifrs9-run` on the last SAST day; the cron also
  makes up a missing one in days 1-5 of the next month (flagged `late`). An administrator can add a late
  run for any ended, unclosed month, or **supersede** a month's run (new run with `supersedesRunId` and a
  reason) until the month closes: `POST /api/ifrs9/runs/monthly` (ADMIN + TOTP, audited). One original
  per tenant per month (partial unique index), each run superseded at most once, and a trigger refuses any
  MONTHLY run for a month that has an accounting batch (the application takes the accounting lock first).
- **Prior stage** for a run is the latest *official* run dated before it that nothing supersedes.
- The accounting close reads the latest MONTHLY run nothing supersedes for a month up to the period
  (`ECL_EXPENSE` / `ECL_ALLOWANCE`, `INTEREST_SUSPENSE`, appended to `ACCOUNT_ROLES`) and refuses
  (`IFRS9_RUN_MISSING`, naming the route) a month without its run once `Ifrs9Config.enabled` and
  `effectiveFromMonth` apply. Lenders without a config row post nothing of this.
- **Write-off** uses the allowance: Dr `ECL_ALLOWANCE` / Cr `BAD_DEBT_EXPENSE`, `ECL_EXPENSE` stays as
  charged, so the loss is the provision plus the bad debt and is not counted twice or released to income.
- **Switching off** is refused while the ledger holds an allowance (it would never be released), and an
  `effectiveFromMonth` earlier than the first unclosed month is refused.

## Reports

`GET /api/ifrs9/runs[?runId=&compareTo=]` returns the stage summary (count, exposure, ECL, coverage,
suspense) and the transition matrix against the previous run (default: the latest run nothing supersedes
against the one before it); `GET /api/reports/export?type=ifrs9-ecl` the workbook (loan ECL, stage summary,
transitions). Settings, parameters, flags and runs: `/api/ifrs9/*` (ADMIN + TOTP to write).

## Known limits

- No discounting at the effective interest rate and no macro-economic overlay: a lender folds both into its
  PD/LGD figures. `NET_BASIS` uses the contractual rate as the EIR proxy.
- The Central Bank's own report layout is not known; the workbook is CredaFlow's format.
- Interest suspension is journalled for consumer loans (`contractType LOAN`); asset-finance contracts are
  provisioned but their interest stays in income and in exposure.
- A backdated MONTHLY run (make-up, late, superseding) rebuilds days past due, paid amounts and outstanding
  principal as at the month end, but reads status, SICR flags, collections stage, debt review, default
  charges and the schedule's rows as they are now, and leaves out a loan that has since left the collectible
  book (settled or written off after the month end).
- A write-off larger than the allowance is covered by the bad debt; an allowance larger than the book
  written off would credit `BAD_DEBT_EXPENSE` net, which cannot happen while ECL <= EAD <= the receivable.
- No UI page: API and workbook only. PD/LGD and settings changes are audited but not yet maker-checked.
