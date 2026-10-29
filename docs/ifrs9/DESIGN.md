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
A loan that is, or was, RESTRUCTURED serves the longer of each stage's probation and
`restructuredProbationMonths` (default 12) at every step down. The snapshot stores a
`restructured` flag (true while RESTRUCTURED, and kept until the probation is served even when a
default trigger wins the stage; a loan back at Stage 1 sheds it), which the next run reads back; the reasons show
`RESTRUCTURE_PROBATION` while it is being served. Because every step takes the longer figure, a
restructured loan that defaulted needs 12 months in Stage 3 and 12 more in Stage 2.

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

`stage3InterestBasis` (default `FULL_SUSPENSION`). Only a Stage 3 loan is ever treated (`suspensionDpd`
is validated never to be below `defaultDpd`; with `suspendOnStage3` on, every Stage 3 loan including its
probation; off, only those at `suspensionDpd`; `suspensionEnabled` off switches both bases off), and only
a consumer loan (`contractType LOAN`): asset-finance interest stays in income and in exposure.

- **`FULL_SUSPENSION` is the regulatory / prudential basis** (the tender's 2.8.3, "automatic suspension of
  interest on non-performing loans", and the usual central-bank NPL rule). All the raised, unpaid contractual
  interest and the default interest owed are held in suspense (`INTEREST_SUSPENSE`, a credit against the
  receivable), none further accrues into exposure, and none of it is provisioned. As it is collected, or the
  loan cures, the figure falls and the next month's delta puts it back into income. On write-off it reduces
  `BAD_DEBT_EXPENSE`.
- **`NET_BASIS` is the IFRS 9 basis** (5.4.1(b): for a credit-impaired asset, interest revenue is the effective
  interest rate on the amortised cost *net of the allowance*; 5.4.2: back to gross only prospectively, when the
  asset is no longer credit-impaired). The allowance stays the ECL on the **gross** exposure, so there is no
  suspense account and no second reserve. Each month a Stage 3 loan's interest raised in that month (instalment
  interest falling due, and default interest charged) is multiplied by ECL / gross exposure; that amount is taken
  off interest income (`Dr INTEREST_INCOME`) and off the ECL expense (`Cr ECL_EXPENSE`), so income is reported
  net of the allowance's share and the impairment line is correspondingly lower, and profit is the same as on the
  gross presentation. The cumulative sum is kept for good: nothing is given back to income on cure, which is the
  prospective treatment. The contractual rate stands in for the effective interest rate (no EIR is computed), the
  whole month's interest is adjusted at the month-end stage and coverage (a loan that entered Stage 3 mid-month is
  adjusted for the whole month), and interest already collected is not reversed. Two choices the lender's auditor
  must accept: the ratio is ECL / EAD (about PD x LGD at Stage 3), not allowance / the ledger's gross receivable
  (EAD also carries interest accrued since the last due date, which the ledger does not yet hold); and the adjustment
  applies only where suspension applies (`suspensionEnabled`, `suspendOnStage3` / `suspensionDpd`, consumer loans), so a
  Stage 3 loan outside those settings is provisioned on the gross exposure with no interest adjustment. That is a
  deliberate deviation from 5.4.1(b), which covers every credit-impaired asset. Only months from `effectiveFromMonth`
  count towards the cumulative adjustment.

Which basis the **financial statements** use is the lender's and its auditor's call; a lender reporting to a central
bank on the prudential basis keeps `FULL_SUSPENSION`. Either way the borrower's balance, schedule, charges and every
NCA document are unchanged. The basis cannot change once IFRS 9 has posted to the ledger (the old basis's entries
would sit beside the new one's).

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
- **The chain.** Each month's stages start from the month before, so a month's first run is refused while the
  previous month (when IFRS 9 governs it) has no run (`PREVIOUS_MONTH_MISSING`), and a month whose run was made
  *before* an earlier month's run was made or replaced is **stale**: its close is refused (`IFRS9_RUN_STALE`) until
  its own run is superseded. Late-running October after November is therefore allowed, and November is then redone.
  A run is also stale when it was made on a Stage 3 interest basis other than the lender's now, and the basis cannot
  be changed while an open month's current run was made on the old one. A MONTHLY run for a month before
  `effectiveFromMonth` is refused (`NOT_EFFECTIVE`), and the close posts nothing for a month IFRS 9 does not govern,
  whatever runs are on record. A run that reads its prior stages, then finds an earlier month's run made or replaced
  under the accounting lock, is refused (`CHAIN_CHANGED`): retry it.
- The accounting close reads the latest MONTHLY run nothing supersedes for a month up to the period
  (`ECL_EXPENSE` / `ECL_ALLOWANCE`, `INTEREST_SUSPENSE`, appended to `ACCOUNT_ROLES`) and refuses
  (`IFRS9_RUN_MISSING`, naming the route) a month without its run once `Ifrs9Config.enabled` and
  `effectiveFromMonth` apply. Lenders without a config row post nothing of this.
- A loan whose status says it was settled, cancelled or written off with no closed / write-off date refuses the close
  (`IFRS9_EXIT_UNDATED`, listing the loans): the close cannot place its exit, and would otherwise keep or release its
  allowance in the wrong month.
- **Write-off** uses the allowance: Dr `ECL_ALLOWANCE` / Cr `BAD_DEBT_EXPENSE`, `ECL_EXPENSE` stays as
  charged, so the loss is the provision plus the bad debt and is not counted twice or released to income.
- **Policy changes the ledger makes unsafe are refused** (`policyChangeRefusal`, under the accounting lock):
  switching off while an allowance or interest in suspense is held (it would never be released); moving
  `effectiveFromMonth` forward over a held position (later months would close on a frozen one); changing
  `stage3InterestBasis` once anything has posted; and an `effectiveFromMonth` earlier than the first unclosed month.

## Reports

`GET /api/ifrs9/runs[?runId=&compareTo=]` returns the stage summary (count, exposure, ECL, coverage,
suspense) and the transition matrix against the previous run (default: the latest run nothing supersedes
against the one before it); `GET /api/reports/export?type=ifrs9-ecl` the workbook (loan ECL, stage summary,
transitions). Settings, parameters, flags and runs: `/api/ifrs9/*` (ADMIN + TOTP to write).

Reports -> IFRS 9 (`/reports/ifrs9`, LOAN_ADMIN and up, as the other finance reports) shows the stage summary, the
movement between stages, the run list (official, late, replaced, stale, analysis) and the Excel export; an ADMIN
there can also run an analysis, add a late month-end run, or replace a month's run (a reason is required). The
server authorizes every write (ADMIN, second factor when the lender requires one).

## Known limits

- No discounting at the effective interest rate and no macro-economic overlay: a lender folds both into its
  PD/LGD figures. `NET_BASIS` uses the contractual rate as the EIR proxy and the month-end stage for the whole month.
- The Central Bank's own report layout is not known; the workbook is CredaFlow's format.
- Interest suspension and the net-basis adjustment are journalled for consumer loans (`contractType LOAN`);
  asset-finance contracts are provisioned but their interest stays in income and in exposure.
- **Backdated monthly runs** (make-up, late, superseding) rebuild the month-end **book**: loans disbursed before the
  month end that had not yet been closed or written off then (a loan since written off or settled is in, one disbursed
  since is out; a cancelled disbursement is out), with each schedule's paid amounts, days past due and outstanding
  principal rebuilt from the receipts live that day (`lib/reports/book-as-of.ts`). What is **not** rebuilt, because no
  history exists, is read as it is now: SICR flags, collections stage, NCA s86 debt review, the loan's status (a loan
  since completed or written off is staged on its days past due alone), default charges owed and charged, and the
  schedule's rows (the early-settlement restore aside). A flag set or a debt review noted after the month end therefore
  stages the month; superseding the run is the correction when that matters.
- A write-off larger than the allowance is covered by the bad debt. An allowance larger than the receivable written
  off is possible: exposure includes interest accrued since the last due date, which is not in the ledger until the
  instalment falls due, so ECL can exceed the receivable by a small amount and the write-off month would credit
  `BAD_DEBT_EXPENSE` net by that amount.
- PD/LGD and settings changes are audited but not yet maker-checked.
