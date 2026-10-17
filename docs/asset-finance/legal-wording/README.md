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

6. CPA s14(2)(b)(i)(bb) cancellation is unilateral; lease 9.10, termination quote 5.1; `lib/asset-finance/lease-termination-store.ts:109` (cancellation takes effect only on `acceptEarlyTermination`); end the lease 20 business days after the lessee's notice whether or not a quote is accepted.
7. CPA s14(3)(b)(ii) and Reg 5(2) cancellation penalty; lease 9.10, termination quote 5.2; `lib/asset-finance/lease-termination.ts:76` and the stored basis text at `lib/asset-finance/lease-termination-store.ts:46`, which the CPA quote prints verbatim in its section 4 ("… plus a penalty of 10.00% of that present value, plus the arrears. The asset is returned; no credit is given for its resale value." beside wording that says the opposite); for a CPA lessee charge the PV of the remaining rentals less the net realisable or re-let value of the returned goods, with no penalty %, reword the basis, and print the PV less goods value instead of the penalty row in section 3. The agreement's section 5 row already reads "Reasonable cancellation penalty: see clause 9.10" for a CPA lessee.
8. CPA s14(2)(d) automatic continuation; lease 9.9, expiry notice 4.1; `lib/asset-finance/lease-daily.ts:47` (only an elected EXTEND is continued); at expiry with no election, extend a CPA lessee's lease month to month.
9. CPA s14(2)(b)(i)(bb) ending a continued lease; lease 9.9(b), expiry notice 3 and 4.1; `lib/asset-finance/lease-end-of-term.ts:119` (`endExtension` uses one month to the next rental date for both parties); let the lessee end it on 20 business days' notice.
10. CPA s14(2)(d) continuation of a lease in default; lease 9.9(b) CPA variant; `lib/asset-finance/lease-end-of-term.ts:85` (refuses EXTEND when the loan is `DEFAULTED`); do not refuse the continuation of a CPA lease; the lessor's remedy is s14(2)(b)(ii).
11. CPA s14(3) damages after the lessor cancels; lease 9.11 CPA variant; `lib/asset-finance/recovery-proceeds.ts:22` (settlement is the loan's full settlement figure); limit a CPA lessee's claim to the amounts owed to cancellation plus the 9.10 charge.
12. Conventional Penalties Act, commercial lease damages; lease 9.11 commercial variant; `lib/asset-finance/recovery-proceeds.ts:22`; discount the remaining rentals to present value at the contract rate.
13. Commercial lease termination date; lease 9.10 commercial, termination quote 5.1–5.2; `lib/asset-finance/lease-termination-store.ts:74` (date = quote date); make it the acceptance date and price the PV on that date.
14. Total loss of leased goods; lease 9.5; not modelled (lease.md point 7); a write-off ends the lease with the PV of the remaining rentals and the arrears, no penalty, less insurance proceeds.
15. Conventional Penalties Act, commercial instalment sale settlement; ISA 7.8 and 7.10; `lib/loan/settlement.ts:307` (`currentSettlementAmount` quotes every remaining payment, unearned interest included, for NON_NCA); Settlement Amount = arrears + outstanding capital + interest accrued to date; after cancellation, that less the net proceeds.
16. Common-law in duplum; ISA 7.9; `lib/asset-finance/non-nca-charges.ts:194` ("No in duplum on a NON_NCA agreement"); stop arrear interest while unpaid interest equals unpaid capital.
17. GLAA s6 and ECTA s13(1) suretyship signature; suretyship (whole deed); `lib/asset-finance/signing-esign.ts:85` (any document may be e-signed); refuse portal e-sign for `SURETYSHIP`: wet ink or an advanced electronic signature only.
18. MPA s15(2)(h) and s15(5) spouse consent; suretyship 5.7, signature section; the spouse is not a signer in the system and no marital status is held (`lib/asset-finance/documents/deal-document-data.ts:42`); record marital status and capture the spouse's consent and two witnesses before payout.
19. Domicilium of the surety; suretyship 5.6; `lib/asset-finance/documents/deal-document-data.ts:42` (`DocumentPerson` has no address); add the surety's physical address and print it.
20. CPA scope of a commercial instalment sale; ISA 7.1–7.3; `lib/asset-finance/lease-deal.ts:36` (`classifyCpaScope` runs for leases only); classify instalment sales and add a CPA variant with s49 notices for a juristic purchaser under the threshold.
24. NCA s104 notice of a rate change, and the contractual notices in ISA 7.5 and lease 9.3; NCA agreement 3.3, ISA 7.5, lease 9.3; `lib/asset-finance/reprice-notice.ts:4` (PARTIAL: only a staff bell, nothing sent or queued for the borrower); send the new rate and instalment or rental to the consumer or lessee in writing.
25. VAT Act s67 rate change on existing leases; lease 9.4; `lib/asset-finance/lease-invoices.ts:82` (a rental whose supply-date VAT rate differs from the booked rate is refused, `vat_rate_changed`); invoice rentals at the rate in force on the supply date, or reword 9.4.
26. Effective date of a reference-rate change; ISA 7.4 and 7.5, NCA agreement 3.3, lease 9.3; `lib/asset-finance/rate-feed-sync.ts:15` (a fetched rate is recorded at the date the feed shows it, which can trail the real change; ZARONIA moves under 0.25 points are not recorded); apply a change from the date the reference rate takes effect, or reword the clauses to "the date the lender records it" (commercial.md point 7).
