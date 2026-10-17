# Common-law scheduled-interest correction

2026-10-17. Fresh review reproduced an overdue schedule with capital 10000,
contractual interest 20000 and no receipts: reducing only additional default
interest left 30000 collectible. This was a defect.

The replay now applies the shared unpaid-interest ceiling to earned contractual
interest as well as default interest, only after an unpaid instalment becomes
overdue. Ordinary settlement before default continues to charge earned interest
under the agreed terms. The original signed/rate-adjusted interest remains in
`RepaymentSchedule.commonLawContractualInterestDue`; effective `interestDue`,
`totalDue`, loan totals, settlement quotes and receipt allocation use collectible
amounts. Dated receipts are replayed against original terms, so an increment
blocked while the ceiling binds is never caught up after payment. New daily
interest can resume when payment releases headroom. The contractual ceiling is
independent of the optional default-charges switch.

Authority: Paulsen v Slip Knot Investments 777 (Pty) Ltd [2015] ZACC 5,
paragraph 42, https://www3.saflii.org/za/cases/ZACC/2015/5.html . Legal reviewer
must assess the conservative assumption that, while default remains open, the
shared ceiling reserves all unpaid earned interest including earned amounts in
the current period that have not yet fallen due. Before default that reservation
does not limit contractual accrual. This implementation does not approve lender
wording or turn on legal-approval flags.

Evidence: focused suites pass (including pre-default settlement, scheduled
interest above capital, partial-payment resumption and no back-accrual).
`commercial-interest.integration.test.ts` exercises real approval/signing/
payout/booking of a 120-month agreement whose original interest exceeds capital,
then shifts fixture dates only. With default charges OFF, quotes cap lawful
interest, partial cash persists effective balances and original evidence, the
next quote never revives blocked interest, and the final receipt closes at the
lawful total. Three real-PostgreSQL tests passed. Full CI and fresh re-review
are required on the final candidate.

Fresh review follow-up: the reviewer's permanent-stop regression failed before
correction (posting deletion and changed receipt split), then passed. A stopped
NON_NCA tenant now keeps stored charge postings and the charge shares already
paid by historical receipts; only net schedule cash enters the contractual
replay. Unpaid default charges remain uncollectible after the permanent stop,
and no new default charge accrues. Contractual-interest protection still runs.
Current main was merged; revised synthetic seed deal amounts from main remain.

A second blind-review regression exposed that frozen history alone was
insufficient: turning the historical default margin off restored contractual
interest previously blocked by competing unpaid default interest (123 became
1000). The engine now retains the original margin, rates, daily competition and
actual charge shares of historical receipts up to the permanent stop. At the
stop it forgives unpaid charges and suppresses all future default-charge
accrual. The loader keeps frozen postings and paid shares as audit history.
The reviewer's actual-loader repro failed before the correction and passed
afterward; a further 2030 replay leaves the historical contractual cap and
charge postings unchanged, with zero collectible default interest.

Stop-day boundary follow-up: a fixed historical charge share valued on the stop
day previously subtracted from an already forgiven balance, creating negative
unpaid default interest and fictitious contractual headroom. The review repro
failed first. After each receipt on or after the stop day, the engine keeps
accrued charges equal to their actually paid fixed shares, so unpaid charges
stay zero. Regression coverage now includes two receipts valued the day before,
on, and after the stop, with no later receipts, and checks the unpaid-interest
ceiling and preserved paid shares. Daily accrual remains bounded by SAST days;
this correction preserves recorded intraday paid shares without inventing
post-stop default accrual or negative unpaid charges.

Full integration follow-up repaired existing synthetic account fixtures exposed
by unconditional NON_NCA replay: accounting loans now have their required
classified, approved/disbursed application and entity parents; recovery
accounts carry a repayment schedule matching their agreed loan money instead
of only a rewritten loan total. Existing agreed interest is copied to rows,
not erased. The concurrent-receipt recovery test now records actual cash and
its allocation rather than changing only Loan.totalPaid. An overdue fixture
replaces its prior schedule rather than appending a duplicate instalment.
Portal privacy checks cover every own-client wet-ink scan across both fixture
deals, still refusing another surety's scan. Repricing settlement assertions
now use earned-period settlement rather than collecting future interest.

A production read-model correction keeps the legal-cap replay independent of
the optional charge switch while reporting `chargesLive` from the actual switch.
SuretyConsent Prisma referential actions now explicitly match the migration's
NO ACTION defaults; migrated PostgreSQL reports `No difference detected`.

Actual-cancellation correction: cancellation is independently evidenced and can
precede repossession and sale. An authorised staff verifier records the actual
effective date, a live legal document of the borrower/agreement, a factual basis
and explicit actual-cancellation confirmation. This is permanent, audited,
tenant-bound and enforced in PostgreSQL. Possession, voluntary return and a sale
never supply an inferred cancellation date. A NON_NCA instalment-sale asset
cannot be sold before the cancellation event is recorded; a later sale links to
that existing event without moving its effective date. The staff loan page has
the evidence/date/confirmation form and the recorded cancellation read model.

The contractual-interest cutoff follows the actual cancellation date even if
proceeds are insufficient. Original signed terms survive in row snapshots and
the cancellation audit. Later quotes, receipts, receipt reversal and repricing
cannot revive future contractual interest. Contractual default interest on the
remaining debt continues to obey demand grace and the common-law ceiling.

The actual-booked PostgreSQL scenario independently calculates interest earned
by January 1 (1549310 cents on 155250000 capital; original interest32970583),
records possession February 1 and sale March 1, and proves March interest would
be higher. The loan stays at the January contractual debt156799310 before and
after the later sale, partial proceeds, future2035 quotes, another cash receipt
and its real staff-route reversal. Missing evidence refuses sale; an officer
cannot record cancellation. Direct forged cutoff, event edit/delete and evidence
soft deletion are rejected by PostgreSQL. Repricing answers contract_cancelled
without a new rate row. Replacing the actual cutoff with maturity failed the
real PostgreSQL oracle (188220583 versus156799310), then source was restored.
