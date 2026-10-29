# IFRS 9 staging, ECL and interest suspension

Tender LPB/0009/2026 items 2.8.2 (staging, SICR, ECL, loan classification and
reports) and 2.8.3 (automatic suspension of interest on non-performing loans).
Code: `lib/ifrs9/`, `prisma/schema/ifrs9.prisma`, accounting hooks in
`lib/accounting/sources-ifrs9.ts` and `store-ifrs9.ts`.

## Staging (`lib/ifrs9/staging.ts`)

| Stage | Trigger (any) |
|---|---|
| 3 | DPD >= `defaultDpd` (90); status DEFAULTED, PENDING_WRITE_OFF or WRITTEN_OFF; collections stage ATTORNEY_REFERRED (legal) |
| 2 | DPD > `sicrDpdOver` (30); status RESTRUCTURED; NCA s86 debt review; an active SICR flag (bureau / behaviour downgrade, watchlist) |
| 1 | none of the above |

IFRS 9 B5.5.19 says "more than 30 days past due" and B5.5.37 says default "no later
than when 90 days past due"; the product's PAR90/NPL is `>= 90` everywhere, so
Stage 3 starts at 90, not 91. The brief's ">90" was read as that definition.

Deterioration is immediate. Improvement waits out a probation per stage
(`stage3ProbationMonths` default 6, `stage2ProbationMonths` default 3), counted in
calendar months from the first run whose triggers were clear, one stage at a time;
a trigger firing again restarts it. All thresholds are per lender (`Ifrs9Config`),
validated in `settings.ts` and by CHECK.

## ECL

`ECL = EAD x PD x LGD`, cents and basis points, rounded half up (BigInt). PD is the
12-month PD for Stage 1 and the lifetime PD for Stages 2 and 3, as the lender enters
it. `Ifrs9EclParameter` rows are `(scopeKey, stage)`; scope is `PRODUCT:<id>`, then
`CONTRACT:<type>`, then `DEFAULT`, most specific first. The DEFAULT row must exist for
all three stages (a run refuses otherwise).

EAD = outstanding principal + unpaid raised interest and fees + default charges owed
+ interest accrued since the last due date (pro rata by day) - interest in suspense.

## Interest suspension

A loan is non-performing for suspension when DPD >= `suspensionDpd` (90) or it is
Stage 3 (including its probation). While it is, the raised and unpaid contractual
interest, and the default interest owed, are the suspended amounts; nothing further
accrues into EAD. In the ledger (consumer loans only) they move
`INTEREST_INCOME` / `DEFAULT_INTEREST_INCOME` -> `INTEREST_SUSPENSE`; as they are
collected the figure falls and the next month's delta puts it back into income. On
write-off the suspended interest reduces `BAD_DEBT_EXPENSE`. The borrower's balance,
schedule, charges and every NCA document are unchanged.

## Runs, snapshots, accounting

`Ifrs9Run` + `Ifrs9LoanSnapshot` are append-only (trigger) and carry the policy and
parameters used. MONTHLY (one per tenant per month, cron `ifrs9-run` on the last SAST
day, make-up in days 1-5) and ON_DEMAND (analysis). The accounting close reads the latest
MONTHLY run on or before the month (`ECL_EXPENSE` / `ECL_ALLOWANCE`, `INTEREST_SUSPENSE`
roles, appended to `ACCOUNT_ROLES`), and refuses (`IFRS9_RUN_MISSING`) a month without
its run once `Ifrs9Config.enabled` and `effectiveFromMonth` apply. Lenders without a
config row post nothing of this.

## Reports

`GET /api/ifrs9/runs[?runId=&compareTo=]` returns the stage summary (count, exposure,
ECL, coverage, suspense) and the transition matrix against the previous run;
`GET /api/reports/export?type=ifrs9-ecl` the workbook (loan ECL, stage summary,
transitions). Settings, parameters, runs and flags: `/api/ifrs9/*` (ADMIN + TOTP to write).

## Known limits

- No discounting at the effective interest rate and no macro-economic overlay: a lender
  folds both into its PD/LGD figures.
- The Central Bank's own report layout is not known; the workbook is CredaFlow's format.
- Interest suspension is journalled for consumer loans (`contractType LOAN`); asset-finance
  contracts are provisioned but their interest stays in income.
- No UI page yet: API and workbook only.
- A make-up monthly run is the position on the day it runs, not the month-end position.
