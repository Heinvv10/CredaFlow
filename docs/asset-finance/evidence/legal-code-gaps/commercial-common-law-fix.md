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
