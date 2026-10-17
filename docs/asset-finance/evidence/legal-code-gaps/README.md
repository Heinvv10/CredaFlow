# Asset-finance legal-code browser acceptance

Synthetic data only. These records exercise local stacks; they do not record a
deployment, lender wording approval, bank settlement or a message to a person.

## NCA surrender and early settlement

`nca-browser-acceptance.json` records the actual browser/API responses and final
stored outcomes. The seeded local tenant kept
`assetFinanceLegalWordingApproved=false`. Staff signed in using passwords and
TOTP; three different staff members captured the bank evidence, verified the
account and authorised release.

The fixture uses existing legacy NCA schedules, not a new origination. Its seed
is `lib/asset-finance/nca-browser-seed.test.ts` (opt-in with
`NCA_LEGAL_BROWSER_SEED=1` on an owned disposable PostgreSQL database).
The first request was resumed after a harness retry. After recording receipt,
the browser received HTTP 409 attempting sale inside the statutory window,
withdrew the request with recorded return of goods, and made a new request.
Only notice/valuation fixture dates were advanced thirty days in the owned DB
to exercise expiry of the wait; the loan clock stayed unchanged.

- `nca-valuation-notice-received.png`: issued valuation and recorded receipt.
- `nca-sale-refused-inside-window.png`: server refusal before the deadline.
- `nca-withdrawn-goods-returned.png`: withdrawal with goods-return evidence.
- `nca-sale-after-window.png`: proceeds recorded after the wait.
- `nca-final-notice-surplus-instructed.png`: final notice and R940 surplus instruction.
- `nca-early-settlement-s125-rebate.png`: R3,060 settlement against R3,150 contractual total.

The final action stored `FINAL_NOTICE_ISSUED` and an `INSTRUCTED` remittance for
94,000 cents together. `nca-surplus-payment-instruction.pdf` contains the
synthetic beneficiary, account and amount; it explicitly does not confirm bank
settlement. `nca-surplus-final-notice.pdf` is the matching DRAFT notice. The
application has no bank-transfer provider for this instruction. Real-bank
execution remains an operator action outside this local acceptance.

## NCA render comparison

`nca-render-comparison/` contains before/after PDF text and hashes against this
branch's main base. The quotation loses its duplicate total row; the agreement
adds cash price, deposit and credit-life premium and loses the duplicate total.
The schedule now comes from production PASQ billing rows and preserves SAST
contract dates. Pagination and watermark extraction move with those rows.
The four statutory notice samples retain their existing bytes. The agreement's
first page was rendered and inspected locally after these changes.

Validation while preparing the NCA candidate: the full unit phase passed
1,521 suites / 19,695 tests; real-PG new-guard suites passed 12 tests; real-PG
standalone surrender receipt and freeze mutation passed for both NCA asset
contract types. Final PR evidence records the complete gate and review outcome.

## Independent NCA code-review fixes

The missing-account exception now has a supported later release: separate bank
verification and authorisation changes the held instruction once, retaining
its original exception, issuer and creation time, with an additional release
actor and timestamp. Issued instructions remain immutable. This only serves
standalone surrenders; linked recoveries retain their existing refund workflow.
Pre-migration issued/listed/sold notices can record historical issue and actual
receipt together with supporting evidence. Existing issue/receipt dates cannot
be rewritten. The new real-PG repros failed before these fixes and now pass;
the combined new-guard suite passes 17 tests, including immutable-release
mutation and four historical-status cases.
