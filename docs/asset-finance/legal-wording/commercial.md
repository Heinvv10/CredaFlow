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
   date); no set-off; order of application of receipts; a tax invoice for the
   cash price (no statutory time of supply asserted); interest exempt.
4. **Interest and changes to the contract rate.** Daily actual/365 on the
   reducing balance. Fixed: no change. Linked: reference + margin, the
   reference defined per basis (Prime, Repo, ZARONIA with each published change,
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
8. **Breach and remedies.** Events of default (business rescue is not one; the
   s133 moratorium is noted); acceleration of the Settlement Amount, or
   cancellation, possession (consent or court order only) and damages of the
   Settlement Amount less the net proceeds; voluntary return; sale, net proceeds, shortfall and surplus;
   charges may be suspended during recovery.
9. **Default interest and collection costs.** From the deal's signed terms:
   none, the contract rate, or the contract rate plus the margin, on unpaid
   capital and contractual interest, stopping at the common-law in duplum
   limit; collection fee per missed payment or none;
   enforcement costs on the attorney-and-own-client scale.
10. **Early settlement.** Settlement Amount = arrears and charges, plus the
    outstanding capital (balloon included), plus interest accrued to the date;
    no unearned interest, no early-settlement fee.
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
   regime; spouse's written consent under MPA s15(2)(h), attested by two
   competent witnesses (s15(5)); section 6 has a witness line for the surety,
   the spouse's line and two witness lines for the spouse.
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
Courts Act 32 of 1944 s45; Matrimonial Property Act 88 of 1984 s15(2)(h) and (5);
Companies Act 71 of 2008 s133;
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

Remaining gaps between the wording and code are listed in
[`README.md`](README.md), "Code changes required before approval". The
resolved signing, spouse-consent, settlement, address and CPA items below
record the implementation for review.

1. **Electronic signature of the suretyship — resolved in code.** GLAA s6
   and ECTA s13(1) require wet ink or an advanced electronic signature. No AES
   provider is configured. Both the portal signature endpoint and database
   refuse electronic signing of a suretyship; staff upload and independently
   confirm its wet-ink scan.
2. **Spouse's consent — resolved in code.** Staff record the surety's marital
   regime for the deed. An UNKNOWN regime or an IN_COMMUNITY surety without a
   verified wet-ink spouse consent blocks payout in the server and database.
   The verification records the actual dates of spouse consent and surety
   execution, with staff attesting that witnessed consent preceded execution
   (including signature order on the same day). MPA s15(4) excludes paragraph
   (h) from subsequent ratification: consent after surety execution cannot
   cure that suretyship. Late recording of genuinely earlier consent is
   allowed. Missing legacy timing blocks payout; no historical date is assumed.
   The verification names the spouse and two distinct witnesses, binds a
   staff-uploaded legal document of the deal, and is audited. No s15(6)
   business exception is assumed.
3. **Surety's address — resolved in code.** The deed prints the physical
   address from the client record in section 1 and in the domicilium clause.
   Staff must complete that address before execution.
4. **NCA suretyship (s4(2)(c), s90).** The NCA variant drops the certificate
   of balance as proof, the jurisdiction consent, the attorney-and-own-client
   cost scale and the renounced evidential exceptions. It **keeps** the
   renunciation of excussion and division and the co-principal-debtor
   liability as common-law terms. Confirm these are lawful under s90(2) for a
   credit guarantee. `ncaApplies` is derived in `loadDealDocumentData` from the
   application's NCA regime (anything but NON_NCA, so an unclassified deal gets
   the NCA variant).
5. **Early settlement (7.10).** The wording now defines the Settlement Amount
   without unearned interest, and damages after cancellation as that amount
   less the net proceeds (Conventional Penalties Act 15 of 1962). Settlement quotes and their settling receipts now remove future unearned interest and keep the original rows as audited evidence. Recovery proceeds are credited against that settlement.
6. **CPA.** CPA scope is now snapshotted for instalment sales using the same evidenced classifier as leases. A small juristic purchaser
   (below the CPA threshold) under a NON_NCA instalment sale may be a CPA
   consumer. The CPA variant expressly preserves the statutory remedies for defective goods, qualifies exclusions and indemnity, and prominently draws attention to risk and indemnity under s49. Confirm the variant against CPA s48, s51 and Reg 44.
7. **Rate-change effective date (7.4) — resolved in code.** The feed uses
   SARB's dated change series (`MRDPRIME`, `MRDREPOR`) and ZARONIA benchmark
   periods, rather than HomePageRates observation dates. Every changed ZARONIA
   value is recorded, without a minimum-move threshold. Full dated history
   recovers intervening events after an outage; human approval still applies.
8. **Lender's own base rate.** A rate set by one party is open to challenge
   as a potestative condition. The wording ties it to a rate published for all
   linked agreements, which matches the per-tenant rate table.
9. **JIBAR tenor and cessation.** The code does not record a tenor; the wording
   says three-month JIBAR "or any rate that officially replaces it".
10. **Rate-change notice (7.5) — resolved in code.** Repricing atomically
    queues a written notice with the new annual rate, effective date, first
    changed payment date and actual scheduled amount (including applicable
    fees, maintenance and VAT). The repricing cron dispatches committed notices
    by email through the audited send pipeline. Missing contacts, blocked,
    simulated and uncertain sends remain pending with recorded outcomes; they
    are not treated as delivered. No SMS is used.
11. **Cancellation before payout (7.5).** Booking is refused when the start
    date has passed or the rate on it differs from the signed rate. The wording
    gives the Seller a right to cancel in those cases; there is no cancellation
    notice in the system.
12. **VAT (7.3).** A tax invoice for the cash price; the agreement no longer
    states a time of supply (VAT Act s9(3)(c) is for the tax adviser); interest
    exempt under VAT Act ss 2 and 12(a). Supply timing (DESIGN D7) was signed off
    (see DESIGN.md sign-off record 2026-10-17).
13. **Insurance premium recovery (7.6).** The Seller may insure and recover the
    premium, but the system has no way to debit it to the loan.
14. **Resolution signers.** The resolution is signed by the authorised
    signatories, or the directors or trustees when none are recorded. The
    system does not check a quorum, that all trustees sign, or that an
    authorised signatory who is not a director may sign a board resolution.
    Trustees must act jointly unless the trust deed provides otherwise.
15. **Business rescue.** Not an event of default in the instalment sale or the
    lease (aligned 2026-10-17); both note the Companies Act s133 moratorium.
16. **Section citations to verify:** NCA s4(2)(c) (credit guarantee scope),
    s101(1)(g) (collection costs), MPA s15(2)(h), VAT Act ss 2 and 12(a).
