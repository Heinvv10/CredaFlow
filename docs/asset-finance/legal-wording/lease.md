# Lease documents: drafted wording (operating and full-maintenance leases)

Status: **draft for the lender's legal team.** Every page keeps the DRAFT
watermark until `TenantConfig.assetFinanceLegalWordingApproved`; nothing here
changes how that flag works. Wording lives in
`lib/asset-finance/documents/wording/` (`lease-agreement*.ts`,
`lease-maintenance.ts`, `lease-servicing.ts`). Rendered samples from synthetic
data: `docs/asset-finance/evidence/legal-wording/lease/`.

A lease is not a credit agreement (`lib/asset-finance/lease-deal.ts`), so no
NCA content appears. Each document has two variants, chosen by data the
renderer already has: the agreement by `LeaseDocumentTerms.cpaApplies`, the
quote by `TerminationQuoteData.cpaCancellation`. The expiry notice is only
queued for CPA lessees (`lease-daily.ts`), so it has one, CPA, variant.

## 1. Lease agreement (`lease/agreement-pdf.ts`, section 9)

Clauses 9.1–9.15 on every lease; 9.16–9.17 on a full-maintenance lease. Headings
unchanged.

| No. | Heading | Summary |
|---|---|---|
| 9.1 | Lease of the goods; ownership remains with the lessor | Names lessor and lessee (from sections 1–2), commencement and end dates; ownership never passes except by a market-value purchase; no encumbrance; landlord's-hypothec notice; registered vehicles in the lessor's name; fines and licences. |
| 9.2 | Delivery, acceptance and risk | Lessee chose goods and supplier; delivery and acceptance certificate; risk on the lessee from delivery to return. Commercial: no lessor warranty, supplier warranties ceded. CPA: s55/s56 preserved; s49 notice. |
| 9.3 | Rentals, escalation and changes to the contract rate | Timing (advance/arrears), escalation %, and for a linked rate: uninvoiced rentals due ≥ 14 days after a rate change are recalculated, term and number of rentals unchanged, maintenance unchanged. Commercial adds "without deduction or set-off". |
| 9.4 | Tax invoices and VAT | One tax invoice per rental on the earlier of due date and payment; VAT at the rate then in force; VAT Act s67 adjustment on a rate change. |
| 9.5 | Insurance of the goods | Comprehensive and liability cover with an insurer of the lessee's choice, lessor noted as owner/first loss payee; lessor may insure at lessee's cost; total loss ends the lease, lessee pays the 9.10 amount without the penalty, less proceeds. CPA: s49 notice. |
| 9.6 | Use, care and location of the goods | Careful use, licensed operators, stay in RSA, lessee services the goods (operating) or presents them for lessor maintenance (FML); no alterations; inspection rights; indemnity (gross negligence carved out). CPA: s49 notice. |
| 9.7 | Contracted usage and excess-usage charges | Allowance a year and excess rate from the annexure; formula as `lease-usage.ts`; billed once at end of term; meter care. Without a usage limit: says none applies. |
| 9.8 | Return of the goods and the end-of-term inspection | Return obligations; inspection on/after the end; fair wear and tear defined; one end-of-term invoice payable in 7 days; 10-business-day objection, credit note if upheld. |
| 9.9 | End-of-term options: return, extension or purchase at market value | Election window 6 months before the last rental, final once recorded; (a) return, (b) month to month at the last rental (and maintenance), ended on a month's notice at the next rental date, (c) purchase at no less than the highest current independent valuation, never a fixed price. If no choice: CPA continues month to month (s14(2)(d)); commercial must return, lessor may treat as extended. |
| 9.10 | Early termination | Formula of `lease-termination.ts` (PV at contract rate + penalty % of PV + VAT + arrears; no resale credit). Commercial: only by agreement, termination date = quote date. CPA: s14(2)(b)(i)(bb) 20 business days' notice; s14(3); Reg 5(2) reasonableness. |
| 9.11 | Breach and remedies | Commercial: events of default, 7-day remedy notice. CPA: 20-business-day notice to remedy (s14(2)(b)(ii)). Remedies: enforce, or cancel, recover by court order and claim arrears plus remaining rentals as damages plus costs; net resale proceeds credited, surplus refunded. |
| 9.12 | Default interest and collection costs | Contract rate + margin from section 5 (or none), daily, actual/365, monthly, not compounding; collection fee per missed rental (or none); allocation order of `non-nca-charges.ts`. |
| 9.13 | Cession and assignment | Lessor may cede and transfer ownership without consent if the lessee's rights are not reduced; lessee may not cede or sublet without consent. |
| 9.14 | Domicilium and notices | Section 1 / section 2 addresses; hand delivery or email. Commercial: deemed receipt. CPA: plain language (s22). |
| 9.15 | General | Whole agreement, variation, no waiver, severability, SA law, POPIA, electronic signature (ECTA). Commercial: Magistrates' Court consent (s45) and certificate of balance as prima facie proof. CPA: CPA rights preserved. |
| 9.16 | Maintenance by the lessor and the maintenance fund | Monthly maintenance and escalation from the annexure; what is and is not covered; fund credited with each invoiced rental's maintenance, debited with paid claims; settlement per risk model (LENDER_RISK: lessor keeps surplus/bears deficit; LESSEE_SETTLED: surplus refunded, deficit invoiced). |
| 9.17 | Maintenance claims and approved providers | Approved providers only; lessor approves against the provider's invoice and pays the provider; rejected work is the lessee's; no claims after the lease ends or after fund settlement. |

Also changed: the section 5 row "Early-termination penalty" now reads "… of the
present value of the rentals outstanding (clause 9.10)"; it said "of the rentals
outstanding", which is not what `lease-termination.ts` computes.

## 2. CPA expiry notice (`lease/expiry-notice-pdf.ts`)

| No. | Heading | Summary |
|---|---|---|
| 4.1 | Consequences of taking no action before the expiry date | The lease continues month to month (s14(2)(d)) at the last rental and maintenance, no material change; either party ends it on the notice period (`extensionNoticeMonths`); to end on expiry, tell the lessor in writing and return the goods. |
| 4.2 | How to tell us your choice (added) | Portal, email or telephone (section 5 contacts); choice final once recorded, confirmed in writing. Added because s14(2)(c) requires the notice to state the options and the lessee needs a way to exercise them. |

## 3. End-of-term inspection report (`lease/inspection-report-pdf.ts`)

It had no placeholder clauses (only an `UNTESTED` marker). Added section 6 "How
this report works" and section 7 "How to reach us" (the lender's contacts, which
the objection clause points to).

| No. | Heading | Summary |
|---|---|---|
| 6.1 | Fair wear and tear | Damage charged only beyond fair wear and tear; the same definition as agreement clause 9.8. |
| 6.2 | How the damage is assessed | Assessed cost of repair, or replacement where repair is uneconomical, excl. VAT, at the inspection date. |
| 6.3 | How excess usage is charged | The `lease-usage.ts` formula; the figure if invoiced, else "calculated when invoiced"; early termination counts only months run. |
| 6.4 | Invoice and payment | One end-of-term tax invoice (with VAT and any fund settlement), payable in 7 days. |
| 6.5 | If you disagree with this report | Written objection within 10 business days; credit note if upheld; undisputed items stay payable. |

## 4. Early-termination quote (`lease/termination-quote-pdf.ts`)

Section 4 still prints the stored `basis` verbatim. Added section 5 "Terms of
this quote"; "How to accept" is now section 6.

| No. | Heading | Summary |
|---|---|---|
| 5.1 | What accepting this quote means | Lease ends on the termination date; the remaining rentals are cancelled; goods returned and inspected, damage/excess/fund settled on a separate invoice; PV and penalty invoiced, due on the termination date; quote lapses if a rental is invoiced or changed. |
| 5.2 (CPA) | Your rights under the Consumer Protection Act | s14(2)(b)(i)(bb) 20 business days; the request is treated as notice, effective on acceptance; s14(3) liability to the termination date and reasonable cancellation penalty; Reg 5(2); raise it with the lessor or the National Consumer Commission. |
| 5.2 (commercial) | Basis of early termination | No right to terminate early; the quote is an offer to end by agreement on clause 9.10's terms, termination date = quote date. |

## Statutory sources relied on

- Consumer Protection Act 68 of 2008: s5(2)(b) and s6 (scope threshold, via
  `cpa-scope.ts`), s14(2)(b)(i)(bb), s14(2)(b)(ii), s14(2)(c), s14(2)(d), s14(3),
  s22 (plain language), s49 (notice of risk and indemnity terms), s51 (no
  waiver of rights, no exclusion for gross negligence), s55 and s56 (quality
  and implied warranty); CPA Regulations, reg 5(2) (cancellation penalty
  factors) and reg 44(3) (grey list: no own-client costs, no evidentiary
  certificate, no jurisdiction consent, no set-off waiver in the CPA variant).
- Value-Added Tax Act 89 of 1991, s67 (rate change on existing contracts).
- Magistrates' Courts Act 32 of 1944, s45 (commercial variant only).
- Insurance Act 18 of 2017 (registered insurer).
- Protection of Personal Information Act 4 of 2013.
- Electronic Communications and Transactions Act 25 of 2002.
- Statutory text is paraphrased and cited, never quoted.

## Drafting choices

- Periods the code fixes are imported, not retyped: election window 6 months,
  extension notice 1 month, end-of-term invoice 7 days (new
  `lib/asset-finance/lease-periods.ts`, re-exported from `lease-end-of-term.ts`
  and `lease-end-invoice.ts` so the documents need not load the servicing
  code), repricing notice 14 days (`reprice.ts`), CPA notice 20 business days
  (`lease-termination.ts`).
- Tenant-configurable periods the renderer does not have (quote validity,
  valuation age) are described without a number ("the period stated on it",
  "the period the lessor's valuation policy sets").
- Fixed choices of mine: commercial remedy period 7 days; judgment unsatisfied
  7 days; objection to the inspection report 10 business days
  (`INSPECTION_OBJECTION_BUSINESS_DAYS`); loss reporting 24 hours.
- The CPA variant puts the s49 "IMPORTANT" notice at the head of clauses 9.2,
  9.5 and 9.6. The writer has no bold-in-paragraph, so it is plain text.

## Points for the lender's legal team

1. **Doing nothing at expiry (code gap).** The expiry notice and clause 9.9
   say a CPA lessee's lease continues month to month (s14(2)(d)). The code
   does not do this: with no election, no `LeaseEndOfTerm` row exists, the
   daily run appends no rentals and the lessee holds the goods rent-free.
   Staff can elect EXTEND for the lessee (no cut-off after expiry), but nothing
   prompts them. The wording follows the statute, not the code; the code needs
   an automatic EXTEND (or a bell item) at expiry for a CPA lessee without an
   election. Commercial lessees: the wording lets the lessor treat the lease
   as extended, which staff can do today.
2. **s14 for small juristic lessees.** s14(1) excludes transactions between
   juristic persons regardless of turnover, as we read it. The code gives s14
   rights (expiry notice, 20-business-day cancellation, Reg 5 limit) to every
   `cpaApplies` lessee, including juristic ones under the threshold, and
   section 8 of the agreement (not drafted here) says "its fixed-term rules
   (section 14) apply". The clauses follow the code. Decide whether juristic
   lessees under the threshold should get the commercial variant of 9.9–9.11.
3. **Lessor ending a month-to-month extension under the CPA.** The notice and
   9.9(b) let either party end it on one month's notice (code:
   `EXTENSION_NOTICE_MONTHS`). Confirm the lessor may do so for a CPA consumer.
4. **CPA cancellation charge.** For a CPA lessee the code charges the full PV
   of the remaining rentals plus the penalty. The wording treats both together
   as the s14(3) "reasonable cancellation penalty" subject to Reg 5(2). Confirm
   whether charging the full PV is reasonable, and whether the penalty % on a
   CPA deal needs a cap.
5. **CPA cancellation depends on accepting a quote.** In the code the
   cancellation takes effect only when the lessee accepts a quote (its
   termination date is quote date + 20 business days). s14 cancellation is a
   unilateral right. The quote says the request is treated as notice "and
   takes effect if you accept"; confirm.
6. **Damages on cancellation for breach (9.11).** Follows the recovery code:
   the claim is the rentals outstanding (undiscounted, VAT-inclusive schedule
   amounts), less net resale proceeds, surplus refunded. Points: undiscounted
   vs the PV basis of early termination (Conventional Penalties Act 15 of 1962
   exposure); VAT on a damages claim; refunding a surplus gives the lessee a
   share of residual value, a finance-lease indicator for tax and IFRS 16.
7. **Total loss (9.5)** is not modelled in the code. The wording charges the
   9.10 amount without the penalty, less insurance proceeds. Staff would have
   to process it manually (an early-termination quote includes the penalty).
8. **VAT rate change (9.4).** The wording follows VAT Act s67 (rentals change
   with the rate). The code refuses a VAT-rate change after booking
   (`vat_rate_changed`, documented PARTIAL). The VAT treatment of termination amounts,
   excess usage, damage and fund settlements was signed off by the tax
   adviser on 2026-10-17.
9. **Purchase option (9.9(c)).** Market value is the highest current assessor
   or dealer valuation, as `lease-term-end.ts` and the portal price it; the
   price is never fixed in the agreement (to avoid recharacterising the
   operating lease). Commercial sale is voetstoots; the CPA variant preserves
   CPA rights (s55(6) limits "as is" sales to consumers).
10. **Inspection objection (9.8, report 6.5).** The 10-business-day objection
    and credit-note route are manual; the code has no dispute status and
    invoices regardless.
11. **Maintenance exclusions (9.16)** are a generic list. Confirm per asset
    class (tyres, undercarriage, ground-engaging tools, consumables) and
    whether the annexure should carry a lender-specific schedule.
12. **Commercial terms to confirm:** own-client costs, certificate of balance,
    s45 consent, set-off waiver, voetstoots, default events (business rescue
    is deliberately not an event of default; confirm), 7-day remedy period.
13. **Domicilium** uses the address in section 2, which can print "Not
    recorded" if the lessee's address is missing; consider refusing to render.
14. **Rate changes (9.3).** The 14-day notice is `REPRICE_NOTICE_DAYS`, marked
    in the code as a product default to confirm. The lessee notice is
    PARTIAL in the code (a staff bell item, nothing sent).
15. **Citations to verify:** s14(2)(b)(i)(bb), s14(2)(b)(ii), s14(2)(d),
    s14(3), reg 5(2), VAT Act s67; the R2m threshold (GN 294, GG 34181) is
    already flagged in `cpa-thresholds.ts`.
