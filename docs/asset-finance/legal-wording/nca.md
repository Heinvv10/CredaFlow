# NCA asset-finance documents: drafted legal wording

DRAFT for the lender's legal team. Every document below keeps its DRAFT
watermark and DRAFT subtitle until `TenantConfig.assetFinanceLegalWordingApproved`
is set for the lender. The wording lives in `lib/asset-finance/documents/wording/nca-*.ts`;
every party, figure, rate and date in it comes from the document data.

Consumer = natural person, sole proprietor, juristic person below the NCA
threshold, or a trust with fewer than three trustees who are all natural persons.

## Approval flag (code change)

The four NCA renderers hard-coded `watermark: true`. They now read
`legalWordingApproved` (from `TenantConfig.assetFinanceLegalWordingApproved`,
`documents/nca/legal-wording-approved.ts`; a missing row or column reads as not
approved). When approved, the watermark, the "DRAFT legal wording" subtitle and
the italic "DRAFT — require lender legal approval" notes under the cost and sale
lines disappear. Wired in `nca-agreement-store.ts`, `nca-entity-signing.ts`
(from the deal-document loader it already calls), `nca-quote-store.ts`,
`surrender-store.ts` and `recovery-notice-data.ts`.

The agreement and quotation data also gained the rate basis, margin and the
reference rate it resolved to, because the Act requires the agreement to say
whether the rate is fixed or variable. The "Annual interest" row now prints the
same description the commercial agreement uses (`rateDescription`).

## 1. NCA instalment sale / finance lease agreement (`documents/nca/agreement-pdf.ts`)

| # | Heading | Summary |
|---|---|---|
| 1 | Interpretation (new) | Defines the Act, the Regulations, the parties (named from the data), the Goods, the Quotation, the Repayment Schedule, business day (s2(5)); states the agreement type (s1: "instalment agreement" or "lease") and size (s9); the Act prevails. |
| 2 | Delivery, possession, risk and ownership | Sale or letting; ownership stays with the Credit Provider until everything (incl. residual) is paid, then passes without further payment; risk on delivery; the Consumer's care, location, no-disposal, notice and inspection duties; eNaTIS titleholder/owner; no entry or repossession without consent or a court order. |
| 3 | Payments, interest and statutory charges | Number of instalments, first and last dates, base instalment, residual; payment method; rate (fixed or reference-linked, daily actual/365, reprice keeps term and residual, s104 notice, s105 cap); initiation and service fees within s105, nothing outside s100/s101; default interest at the contract rate on overdue principal, s101(1)(f)/(g) charges, s103(5) in duplum; s126(3) allocation; VAT and tax invoice. |
| 4 | Insurance and credit-life election | Comprehensive cover up to replacement value, insurer of the Consumer's choice (s106); the lender may arrange cover after notice; credit-life premium from the data with the right to substitute (Credit Life Insurance Regulations, 2017), or "no premium"; insurance proceeds. |
| 5 | Consumer statements and early settlement | Statements at least three-monthly (s108) by the s65 method; s125 settlement at any time; early-termination charge only for a large agreement (s125(3)); settlement quote; ownership passes. |
| 6 | Default, enforcement and statutory notices | Default; no proceedings before the s129(1)(a) notice and the s130 periods (cross-refers, does not restate the notice); s123 termination; s131 attachment → s127(2)–(9), s128; s129(3)/(4) remedying the default (the amended wording: "remedy", costs "up to the time the default is remedied"); costs only as s101(1)(g) allows; s86/s88 debt review. |
| 7 | Voluntary surrender | s127(1) notice; goods already held by the Credit Provider sold at the Consumer's request (s127(1)(b)(i)), otherwise returned within 5 business days; s127(2) valuation notice within 10 business days; s127(3) withdrawal; s127(4)/(5) sale and account; surplus paid, shortfall demanded, 10 business days before proceedings; s128. |
| 8 | Cooling-off right (new) | s121: rescission within 5 business days if signed away from the registered business premises. |
| 9 | Credit information, debt review and complaints (new) | Bureau reporting with 20 business days' notice of adverse information; s86 debt review; complaints and Chapter 7 dispute routes; POPIA. |
| 10 | Addresses and notices | s96 addresses (the Consumer's from the data, the lender's registered office); s65 delivery method; s129 notice delivery; written notices, portal and email. |
| 11 | General | Whole agreement; free copy (s93(2)); variation in writing or as the Act permits; s90 savings and severance; South African law and courts with jurisdiction under the Act (no jurisdiction consent); no waiver; language (s63); cession. |

Headings 2 to 8 of the old placeholder list are kept (renumbered). Three clauses
were added because the agreement is legally incomplete without them: 1
(defined terms and agreement type), 8 (s121 cooling-off) and 9 (bureau, debt
review, complaints, POPIA).

## 2. Pre-agreement statement and quotation (`documents/nca/quote-pdf.ts`)

One clause, "Statutory disclosures and validity period": parties and the s92
purpose; agreement type and s9 size from the principal debt; the quotation is
not an agreement and the acknowledgement is receipt only; binding on the Credit
Provider for five business days after delivery (s92); a variable rate moves with
its reference rate; the rate terms (shared with agreement clause 3.3); total cost
of credit and total repayable from the data; no fees outside s101 except a
lender-placed s106 insurance premium; caps under
s105; insurance and the right to choose the insurer (s106); credit-life premium or
"no premium"; summary of the Consumer's rights (s125, s127, s129, s121, s108, s86).

**Form 20.** I relied on my understanding that the Regulations prescribe the
pre-agreement statement and quotation as Form 20.1 for small agreements and
Form 20.2 for intermediate and large agreements. I have not checked the
regulation numbers against the Gazette, and this renderer does not reproduce
either form's layout. Asset-finance deals are almost always intermediate or
large (Form 20.2). Low confidence on the regulation numbering.

## 3. s127 voluntary-surrender notices (`documents/nca/surrender-pdf.ts`)

- Valuation notice, "Consumer rights following valuation": the request date and
  s127(1) notice; this is the s127(2) notice, with valuer, date and amount; the
  estimate is not a guaranteed price; s127(3) withdrawal within 10 business days
  unless in default; s127(4) sale, not before that period ends; the agreement
  continues until the sale; s127(5) account and notice; surplus paid, shortfall
  demanded with 10 business days to pay; disputes and s128; the consumer is
  asked for a bank account in their name now, so that a surplus can be remitted
  with the post-sale notice.
- Final notice, "Consumer rights following disposal and account reconciliation":
  the s127(5) notice; shortfall demanded (net of unrecoverable charged costs when
  a recovery is linked) with 10 business days before proceedings, or the surplus
  instruction issued with the notice for the account given after valuation;
  payment remains outstanding until bank execution is evidenced,
  or nothing owed; after a shortfall (with or without a linked recovery, the
  same rule as the s131 notice) no interest or charges from the proceeds date
  to 10 business days after the notice; the agreement ends on
  payment either way; disputes and s128.

## 4. s131 repossessed-goods notices (`documents/nca/recovery-pdf.ts`)

- Valuation notice, "Consumer rights following repossession and valuation":
  attachment under a court order, place and date held; s131 applies s127(2)–(9)
  and s128; valuation; s129(3)/(4) remedying the default until the sale; a bank account for any surplus; sale for the
  best price, not before 10 business days after the notice; account and notice
  under s127(5); taxed or awarded legal costs may be charged to the account;
  surplus or shortfall; disputes and s128.
- Final notice, "Consumer rights following sale and account reconciliation":
  s127(5) and s131 notice; shortfall (settlement value plus charged costs less net
  proceeds, net of unrecoverable charged costs) demanded with 10 business days, or
  surplus actually remitted (or an explicit outstanding unverified-account exception), or nothing owed; after a shortfall, charge
  freeze to 10 business days after the notice;
  disputes and s128.

The NON_NCA post-sale statement (`post-sale-statement.ts`) is unchanged and
carries none of this wording (tested).

## Statutory sources relied on

National Credit Act 34 of 2005: s1 (instalment agreement, lease), s2(5), s9,
s63, s65, s86, s88, s90, s92, s93(2), s96, s100, s101(1)(f) and (g), s103(5),
s104, s105, s106, s108, s121, s123, s125 (incl. s125(3)), s126(3), s127(1)–(9),
s128, s129(1)(a), (3) and (4), s130, s131, Chapter 7. The National Credit
Regulations (adverse-information notice; caps); GN R713 of 1 June 2006
(thresholds); Credit Life Insurance Regulations, 2017. National Road Traffic Act
93 of 1996 (titleholder/owner). Value-Added Tax Act 89 of 1991. Protection of
Personal Information Act 4 of 2013. No statutory text is quoted; obligations are
paraphrased with the section cited. Section 129 notice text in `lib/pdf` is
cross-referred, not restated.

## Drafting choices

- Notices address the consumer as "you" and the lender as "we", defined in the
  first sentence with names from the data; the agreement uses "the Consumer" and
  "the Credit Provider".
- Agreement size from the principal debt: large at or above R250 000 (the code's
  `NCA_LARGE_AGREEMENT_THRESHOLD_CENTS`), small below R15 000, else intermediate.
- Fixed periods chosen (no data field): 5 business days for the Consumer to tell
  the lender of a change of location, loss or attachment (2.4(f)); 10 business
  days' notice before the lender arranges insurance (4.2).
- Monthly instalments (the schedule is monthly; the data has no frequency field).
- No certificate-of-balance, renunciation-of-benefits, jurisdiction-consent,
  entry-to-premises or deemed-acknowledgement clauses (s90).

## Points for the lender's legal team

**Resolved in the NCA legal-code changes (2026-10-17).** Section 125
rebates now apply to NCA instalment sales and finance leases, including the
s127 settlement value. Recorded receipt starts the ten-business-day sale
window; proceeds and listing are refused before it expires. A timely withdrawal
records return of the goods. Standalone surrender shortfalls use the same charge
freeze as recoveries.

An evidence-backed determination under s127(6)(a) establishes whether another
credit provider has a registered credit agreement with the same consumer over
the same goods. Unknown never defaults to no. A positive determination routes
the surplus to the National Consumer Tribunal; unrelated consumer debts do not.
Bank proof, independent verification and release authorisation precede a treasury
instruction. Staff then record the already executed external remittance with
its exact amount, date, unique bank reference and retained evidence. Only then
can the ordinary final notice issue, accurately stating recipient and actual
execution date. No bank transfer is initiated by this path.

The expressly authorised unverified-consumer-account exception still issues an
accurate post-sale statement promptly. The surplus remains payable and the
agreement has not statutorily terminated under s127(6)(b); a staff notification
flags the outstanding obligation. Later verified-account release and actual
remittance retain the original statement and exception unchanged, and a
supplemental remittance confirmation records the later payment. This works for
standalone s127, linked s127 and s131 recoveries. A legacy refund release cannot
bypass actual-remittance closure or create a duplicate payment. Evidence and
confirmation reads are access-logged. Loan COMPLETED records settled loan debt;
it is not a representation of surplus discharge or statutory termination.

Agreement disclosures now include cash price,
deposit and monthly credit-life premium, and schedule capital excludes fees.

**Total cost of credit (former gap 23).** Regulation 23A(15)(d), inserted by
[GN R202, Gazette 38557, 13 March 2015](https://www.gov.za/sites/default/files/gcis_document/201503/38557rg10382gon202.pdf),
expressly includes principal debt, interest, initiation fees, service fees and
credit insurance in total cost of credit. The existing shared PASQ calculation
therefore stays unchanged. The duplicate Total repayable table row was removed
from the asset quotation and agreement; the quotation still explains the total.
No consumer-loan PDF pin changed.

4. **s127(2) timing.** `valuationDueOn` is the request date plus 10 business
   days; the Act counts from the later of the notice and the return of the goods.
6. **Lender concession after the shortfall demand.** The lender waives interest,
   fees and charges from application of the proceeds through 10 business days
   after the final notice. This is the existing voluntary concession, not a
   statutory interest prohibition: s127(8) governs the enforcement waiting
   period, while s127(9) otherwise provides for contract-rate interest from
   demand. The waiver, cash calculations and rendered promise remain unchanged.
   [Primary Act, s127(8)–(9)](https://www.justice.gov.za/mc/vnbp/act2005-034.pdf).
7. **NCA deductible cost types.** `recoveryNcaDeductibleCostTypes` defaults
   include towing, storage, repairs, insurance and sheriff's fees. s127(5) allows
   "reasonable costs of the sale"; legal to confirm which are sale costs.
8. **Remedying the default after attachment (s129(3)/(4)).** The s131
   valuation notice says the consumer may remedy the default until the sale. Confirm against s129(4)(b)
   ("execution of any other court order") and current case law.
9. **Subsection citations to verify:** s127(6)–(9) and s128 (cited as a group,
   no time limit stated for the Tribunal review); s129(5)–(7) delivery rules
   (cited as "section 129"); s92 five-business-day validity (team lead cited
   s92(3)); Chapter 7 for complaints; the Regulation requiring 20 business days'
   notice before adverse bureau reporting (not cited by number). I deliberately
   did not cite s122 or s124: I am not certain of their content.
10. **Missing data for s93 / Regulation content of the agreement:** delivery date
    and place; the consumer's chosen delivery method (s65); the lender's bank
    account for payments (clause 3.2 refers to "the account the Credit Provider
    designates"); signing location (s121 is drafted conditionally); insurer
    details; trade-in value (the solver supports it, the document data does not
    carry it); payment frequency; a contact address or email for notices
    (clause 10.3 refers to "the address the Credit Provider publishes").
11. **Repricing notice.** Clause 3.3 promises the s104 notice; `reprice-notice.ts`
    only raises a staff bell (PARTIAL), so a person must send it (README gap 24).
12. **Rate above the cap.** The code refuses the whole repricing (`nca_rate_cap`)
    rather than capping the rate; clause 3.3 says the change "is not applied".
    Confirm that is the intended contractual position.
13. **Quotation validity.** The code never expires a quotation; the agreement
    reuses the quotation's figures whenever it is issued. Five business days is
    the minimum the lender is bound for; the code is more generous.
14. **Large-agreement boundary.** The code's threshold is "at or above R250 000";
    `lib/pdf/creditAgreement.ts` uses "above R250 000". Pick one.
15. **Juristic consumers.** Entity NCA agreements use the same wording; credit
    life (clause 4.3) and POPIA (9.4) read naturally only for a natural person.
16. **Audit rows** record `draftLegalWording` as the inverse of the tenant flag
    (`nca-agreement-store.ts`, `nca-entity-signing.ts`, `surrender-store.ts`,
    `recovery-notices.ts`).
17. **Cash price, deposit and credit-life premium** now appear on both the quote
    and agreement (former gap 21); the lender must still approve the rendered form.
