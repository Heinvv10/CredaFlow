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
After recording receipt,
the browser received HTTP 409 attempting sale inside the statutory window,
withdrew the request with recorded return of goods, and made a new request.
Only notice/valuation fixture dates were advanced thirty days in the owned DB
to exercise expiry of the wait; the loan clock stayed unchanged.

- `nca-valuation-notice-received.png`: issued valuation and recorded receipt.
- `nca-sale-refused-inside-window.png`: server refusal before the deadline.
- `nca-withdrawn-goods-returned.png`: withdrawal with goods-return evidence.
- `nca-sale-after-window.png`: proceeds recorded after the wait.
- `nca-final-refused-before-bank-execution.png`: ordinary notice refused until actual execution.
- `nca-final-notice-surplus-remitted.png`: ordinary notice after R940 remittance proof.
- `nca-early-settlement-s125-rebate.png`: R3,060 settlement against R3,150 contractual total.

The final destination-confirmation browser run records **43 events across three
cases**, using real staff passwords and TOTP: consumer remittance, the explicitly
authorised unverified-account exception followed by later remittance, and
Tribunal remittance where a retained registered agreement concerns the same
consumer and goods. See `nca-remittance-final-browser.json`, the
`nca-remit-consumer-*`, `nca-remit-held-*`, and `nca-remit-tribunal-*` screenshots
and PDFs. Both ordinary notices return 409 before execution; the checkbox
requires confirmation that the exact amount reached the instructed account.

The held case retains the original statement's path and hash after later
execution and downloads a supplemental confirmation. The statement identifies
the unpaid surplus and statutory nontermination. Tribunal documents separately
identify distribution under s127(6)(a), without asserting consumer-remittance
termination under s127(6)(b). Downloads use document access logs. Execution
creates no extra receipt and does not initiate a transfer: the bank proofs and
all counterparties are synthetic local acceptance fixtures.

`nca-before-remittance-timing/` preserves the superseded instruction-only final
notice evidence. It does not prove the corrected ordering. See
`nca-remittance-review/` for rendered text, valuation-pin proof and the checkpoint
verification record. Full CI and fresh delta reviews remain required.

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

The complete gate also exposed the base seed trying to issue and sell the same
NCA valuation notice immediately. The seed now records receipt and leaves that
recovery waiting; a later seed can continue after the statutory window. The
fresh-database seed suite passes all 13 tests, including immediate rerun
idempotency. This changes source fixtures only; no demo stack was restored or
changed.
