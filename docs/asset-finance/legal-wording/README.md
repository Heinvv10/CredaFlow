# Asset-finance legal wording

The drafted wording of every asset-finance document, for the lender's legal
team. Every page keeps the DRAFT watermark until
`TenantConfig.assetFinanceLegalWordingApproved` is set for the lender. The
calculations and rules behind the wording are signed off (DESIGN.md, sign-off
record 2026-10-17); the wording is not.

- [`nca.md`](nca.md): the NCA agreement, quotation, s127 and s131 notices.
- [`lease.md`](lease.md): the lease agreement, CPA expiry notice, inspection
  report and early-termination quote.
- [`commercial.md`](commercial.md): the commercial instalment sale, suretyship
  and resolution.

Rendered samples: `docs/asset-finance/evidence/legal-wording/`, produced by
`scripts/asset-finance/render-legal-wording-nca-samples.ts` and
`scripts/asset-finance/render-legal-wording-deal-samples.ts` (both
deterministic: a rerun reproduces the committed PDFs).

## Code changes required before approval

The wording states the law. Where the system does not yet do what the wording
says, the gap is listed here. While any line remains, the flag must not be set
for any lender (DESIGN.md, sign-off record). One line per gap: rule; clause;
code; what must change.

1. NCA s125 settlement; NCA agreement 5.2, quote 1.7; `lib/loan/settlement.ts:182` (`isS125InstalmentLoan` requires `LOAN`); apply the s125 rebate to NCA `INSTALMENT_SALE` and `FINANCE_LEASE`, which also corrects the s127 "settlement value".
2. NCA s127(3) withdrawal; agreement 7.3, s127 valuation notice 1.2; `prisma/schema/asset-finance.prisma:482` (`SurrenderStatus` has no withdrawn state); add a withdrawal step that returns the goods.
3. NCA s127(3)/(4) no sale inside 10 business days; agreement 7.3–7.4, s127 valuation 1.3, s131 valuation 1.3; `lib/asset-finance/surrender-store.ts:117`, `lib/asset-finance/recovery-sale.ts:63`; refuse proceeds, listing and sale until 10 business days after the valuation notice is received.
4. NCA s127 surplus remitted with the post-sale notice; s127/s131 valuation 1.6, final 1.2; `lib/asset-finance/recovery-freeze.ts:39` (`SURPLUS_HELD`), `lib/asset-finance/recovery-refund.ts:36`; collect and verify the consumer's bank account at the valuation stage and pay the surplus when the final notice issues.
5. NCA s127 charge freeze after a shortfall, both paths; s127 final 1.3, s131 final 1.3; `lib/asset-finance/surrender-store.ts:112` (a surrender without a recovery sets no freeze); freeze charges from the proceeds date to 10 business days after the final notice on every surrender, as `recoveryChargeFreeze` does for a recovery.
11. CPA lessor cancellation: the reasoned net-charge and collectible-cost concession candidate awaits §8 guard approval, actual booked PostgreSQL/mutation proof, browser and final review. Actual vendor expenses, cash and the single goods receipt must remain preserved.
14. Total-loss closure: the evidenced TOTAL_LOSS outcome, unavailable asset and actual maintenance-refund proof candidate awaits §8 guard approval and PostgreSQL race/closure acceptance. No fictitious inspection or return to stock is permitted.

21. NCA s93 content of the agreement; NCA agreement 3.7 and 4.3; `lib/asset-finance/documents/nca/agreement-pdf.ts` (only the quote prints them); print the cash price, deposit and credit-life premium on the agreement.
22. NCA schedule split (not a legal rule, found while regenerating the samples); NCA agreement and quote repayment schedules; `lib/asset-finance/schedule-records.ts:111` (`principalDue = payment - interest + balloon`, and an NCA row's payment includes its fees, so `principalDueCents` also carries the initiation and service fees that `feesDueCents` shows again); the printed capital column over-counts by the fees and its rows sum to more than the principal debt. Fix the split, then check every consumer of the PASQ billing schedule.
23. "Total cost of credit" (NCA s101 / Reg 31, Form 20); quote 1.5 and the "Total cost of credit" rows of the NCA quote and agreement; `lib/compliance/pasq.ts:190` (`calculatePasqTotalCostOfCreditCents` adds the principal debt, so the row equals "Total repayable"; shared with the consumer-loan PASQ, so not changed here); confirm the Form 20 / Reg 31 meaning of "total cost of credit". If it excludes the principal, fix `calculatePasqTotalCostOfCreditCents` and quote 1.5; if not, drop the duplicate row from the asset quote and agreement.
24. NCA s104 notice of a rate change, and the contractual notices in ISA 7.5 and lease 9.3; NCA agreement 3.3, ISA 7.5, lease 9.3; `lib/asset-finance/reprice-notice.ts:4` (PARTIAL: only a staff bell, nothing sent or queued for the borrower); send the new rate and instalment or rental to the consumer or lessee in writing.
26. Effective date of a reference-rate change; ISA 7.4 and 7.5, NCA agreement 3.3, lease 9.3; `lib/asset-finance/rate-feed-sync.ts:15` (a fetched rate is recorded at the date the feed shows it, which can trail the real change; ZARONIA moves under 0.25 points are not recorded); apply a change from the date the reference rate takes effect, or reword the clauses to "the date the lender records it" (commercial.md point 7).
