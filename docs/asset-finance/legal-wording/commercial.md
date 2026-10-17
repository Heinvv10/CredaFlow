# Asset finance legal wording: commercial documents (DRAFT)

Drafted 2026-10-17 for the lender's legal team to review. The documents keep
the DRAFT — NOT FOR EXECUTION watermark until the lender sets
`TenantConfig.assetFinanceLegalWordingApproved`. Every party, figure, rate and
date is the deal's own data, printed in the document's numbered sections; no
lender name, rate or amount is hard-coded.

Code: `lib/asset-finance/documents/wording/` (`instalment-sale.ts`,
`instalment-sale-enforcement.ts`, `suretyship.ts`, `resolution.ts`,
`commercial-common.ts`). Sample renders from the synthetic fixture:
`docs/asset-finance/evidence/legal-wording/commercial/`.

## Where each document is used

| Document | Rendered for | NCA? |
|---|---|---|
| Instalment sale agreement | entity deals classified NON_NCA | never: an NCA entity deal gets `documents/nca/agreement-pdf.ts`; a natural person (sole proprietor) is refused this document |
| Deed of suretyship | every active surety of an entity deal | also for NCA entity deals (small juristic persons, trusts with fewer than three natural-person trustees) via `nca-entity-signing.ts` |
| Resolution | the entity's authorised signatories | also for NCA entity deals |

The suretyship and resolution are also rendered for an entity's operating or
full-maintenance lease; their wording refers to "the Agreement" by reference
number, not to an instalment sale.

## Instalment sale agreement (section 7, clauses 7.1–7.13)

1. **Sale of the goods and ownership.** Defines the parties and the Goods;
   ownership reserved until every amount (including the balloon) is paid;
   no warranty by the Seller, supplier warranties ceded; landlord notice and no
   accession; CPA savings (ss 55, 56).
2. **Delivery, acceptance and risk.** Supplier delivers; delivery and
   acceptance certificate before payout; risk on delivery; indemnity.
3. **Payment.** Deposit and scheduled payments (balloon named with its due
   date); no set-off; order of application of receipts; one VAT invoice for the
   cash price at the payout date; interest exempt.
4. **Interest and changes to the contract rate.** Daily actual/365 on the
   reducing balance. Fixed: no change. Linked: reference + margin, the
   reference defined per basis (Prime, Repo, ZARONIA with its 0.25-point rule,
   JIBAR, the lender's base rate), changes follow the reference.
5. **Commencement and recalculation of the schedule.** Schedule runs from the
   printed start date; if the Seller has not paid the Supplier by then, or the
   rate on that date differs, the Seller may cancel and a new agreement is
   concluded; on a rate change the remaining payments are re-solved with the
   same number, dates, weights and balloon, with written notice.
6. **Insurance of the goods.** Comprehensive cover at replacement value, Seller
   noted as owner and first loss payee, cession of policy rights, Seller may
   insure at the Purchaser's cost, 48-hour loss report.
7. **Use, maintenance and location of the goods.** Careful lawful business
   use, servicing, licensing (Seller titleholder), kept at the printed address
   or a notified place in South Africa, inspection, tracker on request,
   attachment notice.
8. **Breach and remedies.** Events of default; acceleration of the Settlement
   Amount, or cancellation, possession (consent or court order only) and
   damages; voluntary return; sale, net proceeds, shortfall and surplus;
   charges may be suspended during recovery.
9. **Default interest and collection costs.** From the deal's signed terms:
   none, the contract rate, or the contract rate plus the margin, on unpaid
   capital and contractual interest; collection fee per missed payment or none;
   enforcement costs on the attorney-and-own-client scale.
10. **Early settlement.** Settlement Amount = arrears and charges plus every
    remaining scheduled payment, interest included, no rebate.
11. **Cession and assignment.** Seller free to cede; Purchaser needs consent.
12. **Domicilium and notices.** Seller's registered office and the
    Purchaser's printed address; hand, registered post or designated email.
13. **General.** Whole agreement and non-variation, no waiver, certificate of
    balance as prima facie proof, s45 Magistrates' Court consent, governing
    law, authority warranty, severability, POPIA consent, counterparts and
    electronic signature.

## Deed of suretyship (section 5, clauses 5.1–5.8)

1. **Suretyship and co-principal debtor.** Names the surety, the principal
   debtor and the agreement reference; joint and several, no prior claim
   against the debtor.
2. **Extent of the suretyship.** All amounts under or arising from the
   Agreement, including on cancellation; not capped at the printed total.
3. **Renunciation of benefits.** Commercial: excussion, division, cession of
   actions and the exceptions non numeratae pecuniae, non causa debiti, errore
   calculi. NCA variant: excussion and division only, plus an NCA savings line.
4. **Continuing covering security.** Lasts until the Agreement's obligations are
   discharged; binds the estate; no withdrawal; indulgences and releases.
   Commercial: Creditor may vary the Agreement without consent. NCA variant:
   only time, indulgence, contract-rate changes and releases; any other
   variation that increases the debt needs the surety's written consent.
5. **Certificate of balance.** Commercial: prima facie proof. NCA variant: a
   statement on request that the surety may dispute.
6. **Domicilium and notices.** Creditor's registered office; the surety's last
   notified residential address.
7. **Marital status and spouse's consent** (added). Warranty of marital
   regime; spouse's written consent under MPA s15(2)(h); a spouse signature
   line was added to section 6.
8. **General.** Whole deed, non-variation, acceptance by acting on it,
   cession with the Agreement, POPIA consent. Commercial only: s45
   Magistrates' Court consent.

The "Marital status and spouse's consent" clause is new, so "General" moved
from 5.7 to 5.8.

## Resolution (section 4, clauses 4.1–4.3)

1. **Approval of the transaction.** Who passes it, by entity type (company:
   board meeting or Companies Act s74 written consent; CC: members under the
   association agreement and the CC Act; trust: trustees acting jointly with
   Letters of Authority under TPCA s6, Master's reference printed if
   recorded; partnership: partners); resolves to enter the Agreement and its
   ancillary documents; interest and powers confirmation.
2. **Authority to sign.** The person(s) in section 3, acting together when
   there are several (the system requires each of them to sign).
3. **Ratification.** Prior acts ratified; resolution properly passed and
   unrevoked; reliance until written revocation.

## Statutory sources relied on

NCA 34 of 2005 ss 4(2)(c), 90, 101(1)(g); CPA 68 of 2008 ss 5, 55, 56;
VAT Act 89 of 1991 ss 2, 12(a); Insurance Act 18 of 2017; Magistrates'
Courts Act 32 of 1944 s45; Matrimonial Property Act 88 of 1984 s15(2)(h);
Companies Act 71 of 2008 s74; Close Corporations Act 69 of 1984; Trust
Property Control Act 57 of 1988 s6; POPIA 4 of 2013. No statutory text is
quoted; obligations are paraphrased and cited.

## Drafting choices (fixed values the data does not carry)

- 7 days to pay after written demand, and 14 days to remedy another breach,
  before an event of default (7.8). The code requires a letter of demand step
  before summons on a NON_NCA loan but holds no period.
- 7 days for an unsatisfied judgment (7.8).
- 48 hours to report loss or damage (7.6).
- Domicilium change effective 7 days after receipt; registered post deemed
  received on the 7th business day; email on the next business day (7.12).
- Collection fee stated as "including any value-added tax".
- Suretyship covers this Agreement only (with its variations and rate
  changes), not all the debtor's present and future debts.

## Points for the lender's legal team

1. **Electronic signature of the suretyship.** A suretyship must be in
   writing and signed by the surety (General Law Amendment Act 50 of 1956
   s6). ECTA 25 of 2002 s13(1) requires an *advanced* electronic signature
   where a law requires a signature and names no type. The portal e-sign is
   not an advanced electronic signature, so an e-signed suretyship may be
   unenforceable. Consider wet ink only for suretyships. The wording does not
   address this because the code allows e-sign.
2. **Spouse's consent.** The data has no marital status and the spouse is
   not a signer in the system: the consent line prints, but e-sign cannot
   capture it and nothing gates payout on it. Confirm the s15 formalities
   (including any witness requirement in s15(5)) and whether the s15(6)
   business exception can apply to a director's suretyship.
3. **Surety's address.** The data carries only the surety's name and ID
   number, so the domicilium is "the residential address last notified".
   Recommend adding the surety's address to the document data.
4. **NCA suretyship (s4(2)(c), s90).** The NCA variant drops the certificate
   of balance as proof, the jurisdiction consent, the attorney-and-own-client
   cost scale and the renounced evidential exceptions. It **keeps** the
   renunciation of excussion and division and the co-principal-debtor
   liability as common-law terms. Confirm these are lawful under s90(2) for a
   credit guarantee. The variant is selected by `ncaApplies`, which only
   `nca-entity-signing.ts` sets; no integration test covers that wiring.
5. **Early settlement without rebate (7.10).** The code's settlement figure is
   every remaining scheduled payment including unearned interest. That is
   aggressive and the acceleration remedy (7.8) uses the same figure; consider
   the Conventional Penalties Act 15 of 1962 and whether to rebate future
   interest (the code would have to change).
6. **CPA.** CPA scope is computed only for leases. A small juristic purchaser
   (below the CPA threshold) under a NON_NCA instalment sale may be a CPA
   consumer. The no-warranty and no-set-off terms rely on a CPA savings line
   (7.1). Confirm against CPA s48, s51 and Reg 44.
7. **Rate-change effective date (7.4).** Fetched SARB rates are recorded with
   the date the feed showed them, which can trail the real change, and
   ZARONIA moves are recorded only at 0.25 points or more from the latest live
   value. The wording says the change takes effect "from the date on which the
   changed reference rate takes effect". Decide whether to word it as "the date
   the Seller records".
8. **Lender's own base rate.** A rate set by one party is open to challenge
   as a potestative condition. The wording ties it to a rate published for all
   linked agreements, which matches the per-tenant rate table.
9. **JIBAR tenor and cessation.** The code does not record a tenor; the wording
   says three-month JIBAR "or any rate that officially replaces it".
10. **Rate-change notice (7.5).** The code alerts staff to send the notice but
    does not send it (`reprice-notice.ts`, PARTIAL). The wording promises
    written notice.
11. **Cancellation before payout (7.5).** Booking is refused when the start
    date has passed or the rate on it differs from the signed rate. The wording
    gives the Seller a right to cancel in those cases; there is no cancellation
    notice in the system.
12. **VAT (7.3).** One tax invoice at the payout date; interest exempt under
    VAT Act ss 2 and 12(a). The tax memo on supply timing (DESIGN D7) is still
    outstanding.
13. **Insurance premium recovery (7.6).** The Seller may insure and recover the
    premium, but the system has no way to debit it to the loan.
14. **Resolution signers.** The resolution is signed by the authorised
    signatories, or the directors or trustees when none are recorded. The
    system does not check a quorum, that all trustees sign, or that an
    authorised signatory who is not a director may sign a board resolution.
    Trustees must act jointly unless the trust deed provides otherwise.
15. **Business rescue.** Enforcement against a purchaser in business rescue is
    subject to the moratorium in Companies Act s133; the wording does not try
    to override it.
16. **Section citations to verify:** NCA s4(2)(c) (credit guarantee scope),
    s101(1)(g) (collection costs), MPA s15(2)(h), VAT Act ss 2 and 12(a).
