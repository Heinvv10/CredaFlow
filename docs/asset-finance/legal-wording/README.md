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
6. CPA s14(2)(b)(i)(bb) cancellation is unilateral; lease 9.10, termination quote 5.1; `lib/asset-finance/lease-termination-store.ts:109` (cancellation takes effect only on `acceptEarlyTermination`); end the lease 20 business days after the lessee's notice whether or not a quote is accepted.
7. CPA s14(3)(b)(ii) and Reg 5(2) cancellation penalty; lease 9.10, termination quote 5.2; `lib/asset-finance/lease-termination.ts:76` and the stored basis text at `lib/asset-finance/lease-termination-store.ts:46`, which the CPA quote prints verbatim in its section 4 ("… plus a penalty of 10.00% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value." beside wording that says the opposite); for a CPA lessee charge the PV of the remaining rentals less the net realisable or re-let value of the returned goods, with no penalty %, reword the basis, and print the PV less goods value instead of the penalty row in section 3. The agreement's section 5 row already reads "Reasonable cancellation penalty: see clause 9.10" for a CPA lessee.
8. CPA s14(2)(d) automatic continuation; lease 9.9, expiry notice 4.1; `lib/asset-finance/lease-daily.ts:47` (only an elected EXTEND is continued); at expiry with no election, extend a CPA lessee's lease month to month.
9. CPA s14(2)(b)(i)(bb) ending a continued lease; lease 9.9(b), expiry notice 3 and 4.1; `lib/asset-finance/lease-end-of-term.ts:119` (`endExtension` uses one month to the next rental date for both parties); let the lessee end it on 20 business days' notice.
10. CPA s14(2)(d) continuation of a lease in default; lease 9.9(b) CPA variant; `lib/asset-finance/lease-end-of-term.ts:85` (refuses EXTEND when the loan is `DEFAULTED`); do not refuse the continuation of a CPA lease; the lessor's remedy is s14(2)(b)(ii).
11. CPA s14(3) damages after the lessor cancels; lease 9.11 CPA variant; `lib/asset-finance/recovery-proceeds.ts:22` (settlement is the loan's full settlement figure); limit a CPA lessee's claim to the amounts owed to cancellation plus the 9.10 charge.
12. Conventional Penalties Act, commercial lease damages; lease 9.11 commercial variant; `lib/asset-finance/recovery-proceeds.ts:22`; discount the remaining rentals to present value at the contract rate.
13. Commercial lease termination date; lease 9.10 commercial, termination quote 5.1–5.2; `lib/asset-finance/lease-termination-store.ts:74` (date = quote date); make it the acceptance date and price the PV on that date.
14. Total loss of leased goods; lease 9.5; not modelled (lease.md point 7); a write-off ends the lease with the PV of the remaining rentals and the arrears, no penalty, less insurance proceeds.
25. VAT Act s67 rate change on existing leases; lease 9.4; `lib/asset-finance/lease-invoices.ts:82` (a rental whose supply-date VAT rate differs from the booked rate is refused, `vat_rate_changed`); invoice rentals at the rate in force on the supply date, or reword 9.4.

26. Active operating/full-maintenance leases can require a zero future rental after a large late effective-date rate cut. Existing `LeaseRental_amounts` requires a positive rental. The narrow nonnegative-rental CHECK replacement is awaiting the goal §8 confirmation; it has not been implemented or applied.
