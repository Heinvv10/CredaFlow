# NCA criteria and regression evidence

| Former gap | Enforcement and regression |
|---|---|
| 1 | `s125-settlement.test.ts`; actual receipts for both NCA asset types in `nca-surrender-proceeds.integration.test.ts` preserve the original contractual total and close at the rebated amount. |
| 2 | `nca-sale-window.integration.test.ts`: recorded receipt, goods-return proof, timely withdrawal and re-request; trigger-removal mutation admits the missing-proof attack. |
| 3 | Same PG suite: listing and the payment receipt itself refuse missing/immature receipt evidence; removing each guard admits the attack. Recovery paths share `requireNcaSaleWindow`. |
| 4 | `nca-surplus.integration.test.ts`: independent account verification/release, exact amount, held-account exception and deferred final-notice constraint; mutations remove actor, amount and final-notice guards. `nca-remittance-timing.integration.test.ts` additionally proves instruction → actual external bank execution → ordinary final notice, held linked/s131 payable closure, unknown refusal and Tribunal routing. Browser evidence records the final notice refused before execution, then issued after exact synthetic execution. |
| 5 | `nca-surrender-proceeds.integration.test.ts`: both asset types accrue zero default interest past maturity while the stored standalone freeze is open; removing only that stored freeze causes positive interest. `recovery-pauses.test.ts` checks bounded pause/resumption. |
| 21 | `documents/nca/nca-documents.test.ts` checks cash price, deposit and credit-life rows in rendered text. |
| 22 | `nca-evidence.test.ts` and `schedule-records.test.ts` check capital/interest/fee identities; the sample renderer now reads production PASQ billing rows and asserts their sum and contract dates. Agreement/quote store regression tests also assert SAST dates. |
| 23 | Regulation 23A(15)(d) includes principal. Asset document tests require a single total row; shared consumer PASQ is unchanged. |

All PostgreSQL suites use owned disposable databases. Browser fixtures are
legacy servicing fixtures; no claim is made here about a new origination or
external bank execution. The PR's final validation record must separately
record full CI and independent review at the final head.
