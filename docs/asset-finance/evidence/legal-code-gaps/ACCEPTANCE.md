# Legal-code-gaps acceptance evidence

Synthetic local data only. Original scope: 26 items in the 2026-10-17 goal.
The lender legal-wording flag remains false. No consumer PASQ output/pins,
real messages/payments, deployment, demo/Fairscore stack or spending changed.

## Rule-to-regression register

Paths below are under `lib/asset-finance/` unless prefixed otherwise. Every
listed PG suite runs through the complete integration gate's RUN_* variables;
unit/mocked tests alone are not evidence for its database enforcement.

| Item | Implemented rule | Primary regression evidence |
|---|---|---|
| 1 | NCA asset s125 rebate | `lib/loan/s125-settlement*.integration.test.ts`, `nca-independent-adversary.integration.test.ts` |
| 2 | Evidenced surrender withdrawal | `nca-guards.integration.test.ts`, `nca-independent-adversary.integration.test.ts` |
| 3 | Actual receipt + ten business-day sale wait | `nca-sale-window.integration.test.ts` |
| 4 | Actual remittance/held exception/Tribunal | `nca-remittance-timing.integration.test.ts`, `nca-s131-independent-edge.integration.test.ts`, `nca-surplus.integration.test.ts` |
| 5 | Standalone and linked shortfall charge freeze | `nca-surrender-proceeds.integration.test.ts`, `lib/loan/recovery-pauses.test.ts` |
| 6 | Unilateral CPA cancellation on notice | `lease-legal.integration.test.ts` |
| 7 | Reasoned Reg5 assessment under financial ceiling | `lease-legal.integration.test.ts`, `reprice-cpa-assessment.integration.test.ts` |
| 8 | Automatic monthly continuation | `lease-legal.integration.test.ts`, `lease-tester-b.integration.test.ts` |
| 9 | Twenty-business-day continuation notice | `lease-legal.integration.test.ts` |
| 10 | CPA continuation despite default | `lease-tester-b.integration.test.ts` |
| 11 | Lessor CPA reasoned net damages/concessions | `lessor-cancellation-assessment.integration.test.ts`, `reprice-cpa-assessment.integration.test.ts` |
| 12 | Commercial lease discounted damages | `lease-legal.integration.test.ts`, `reprice-after-supply-cancellation.integration.test.ts` |
| 13 | Actual commercial acceptance valuation date | `lease-legal.integration.test.ts`, `lease-tester-b-historical.integration.test.ts` |
| 14 | Loss-date PV, actual insurer receipts, honest closure | `blind-code-total-loss.integration.test.ts`, `lease-tester-b.integration.test.ts`, `reprice-cpa-assessment.integration.test.ts` |
| 15 | Earned-interest commercial settlement/cancellation | `commercial-interest.integration.test.ts`, `TESTER-C-FINAL.md` |
| 16 | Common-law in-duplum ceiling | `commercial-interest.integration.test.ts`, `commercial-legal.test.ts` |
| 17 | Surety wet-ink requirement | `commercial-browser.integration.test.ts`, `payout-booking.integration.test.ts` |
| 18 | Prior witnessed spouse consent + retained proof | `payout-booking.integration.test.ts`, `security-surety-race.integration.test.ts` |
| 19 | Surety physical address printed | `commercial-legal.test.ts`, asset sample text/render comparison |
| 20 | ISA CPA classification/s49 variant | `commercial-legal.test.ts`, `commercial-interest.integration.test.ts` |
| 21 | Cash/deposit/credit-life agreement disclosures | `documents/nca/legal-wording-approved.test.ts`, NCA render comparisons |
| 22 | Separate capital/interest/fees | `schedule-records.test.ts`, `reprice-nca-pasq.integration.test.ts` |
| 23 | Principal included under Reg23A(15)(d); asset duplicate removed | NCA render comparisons and `legal-wording/nca.md`; consumer PASQ and pins unchanged |
| 24 | Durable written notice, real dispatch evidence/deadlines | `reprice-notice-db.integration.test.ts`, `rate-notice-deadline.integration.test.ts` |
| 25 | Actual supply-date VAT and own-supply credits | `lease-legal.integration.test.ts`, `lease-rental-floor.integration.test.ts` |
| 26 | Actual benchmark effective date and rental floor | `rate-feed.integration.test.ts`, `lease-rental-floor.integration.test.ts`, `reprice-cpa-assessment.integration.test.ts` |

## Acceptance boundaries

Full CI and merge ancestry are recorded in the PR checks and final execution
handoff after the gates actually complete. Earlier failed/interrupted runs remain diagnostic records,
not full-CI passes. Browser evidence is in the NCA, commercial and lease folders;
`lease-final-browser/` records the final reasoned-assessment/refund forms.
