// Lease clauses 9.9–9.15: the end of the term, early termination, breach,
// default interest, cession, notices and general terms (./lease-agreement.ts
// assembles them). DRAFT wording; the rules behind it are signed off (see
// DESIGN.md sign-off record 2026-10-17). The periods are the code's
// (lease-end-of-term.ts, lease-termination.ts, lease-end-invoice.ts). Where the
// wording states the law and the code does not yet do it, the gap is listed in
// docs/asset-finance/legal-wording/README.md ("Code changes required before approval").
import { Prisma } from "@prisma/client"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { ELECTION_WINDOW_MONTHS, END_OF_TERM_PAYMENT_DAYS, EXTENSION_NOTICE_MONTHS } from "../../lease-periods"
import { CPA_CANCELLATION_NOTICE_BUSINESS_DAYS } from "../../lease-termination"
import { percentPdf } from "../document-parts"
import { formatIsoDatePdf } from "../pdf-layout"
import type { LeaseWordingInput, WordingClause } from "./lease-agreement"

/** Days a commercial lessee has to remedy a breach after written notice. */
export const COMMERCIAL_REMEDY_DAYS = 7

const para = (...parts: (string | false)[]): string => parts.filter((p): p is string => p !== false).join("\n\n")
const months = (n: number): string => (n === 1 ? "one month" : `${n} months`)
const CPA_DAYS = `${CPA_CANCELLATION_NOTICE_BUSINESS_DAYS} business days`

type Lessee = Pick<LeaseWordingInput, "naturalPerson">
/** What a s14 term rests on: the statute for a natural-person lessee, this agreement for a juristic one (s14(1) excludes it). */
export const s14Source = (i: Lessee, subsection: string): string => (i.naturalPerson ? `section 14(${subsection}) of the CPA` : "this agreement")
/** For a juristic lessee, the sentence that says why the agreement gives the s14 term; nothing for a natural person. */
export const s14Note = (i: Lessee, subsection: string, who: string, what = "the same terms as the CPA gives a natural-person consumer"): string => (i.naturalPerson ? ""
  : ` Section 14(${subsection}) of the CPA does not apply to a juristic lessee, but this agreement gives ${who} ${what}.`)

function endOptions(i: LeaseWordingInput): string {
  const maintenance = i.fml ? " and maintenance" : ""
  const extensionEnd = i.cpa
    ? `The lessee may end the extension at any time by giving the lessor at least ${CPA_DAYS}' written notice; it then ends on the date in the notice, not earlier than `
      + `${CPA_DAYS} after the notice. The lessor may end it by written notice; it then ends on the first rental date at least ${months(EXTENSION_NOTICE_MONTHS)} after the `
      + "notice. The goods are then returned under clause 9.8."
    : `Either party may end the extension by written notice; it then ends on the first rental date at least ${months(EXTENSION_NOTICE_MONTHS)} after the notice (and not `
      + "before the end of the period already invoiced), and the goods are returned under clause 9.8. A lease in default is not extended."
  return para(
    `From ${months(ELECTION_WINDOW_MONTHS)} before the last rental falls due, the lessee may choose one of the options below for the end of the term, through the lessor's portal `
    + "or by written notice to the lessor. The choice is final once the lessor records it.",
    "(a) Return. The lessee returns the goods under clause 9.8 when the term ends.",
    `(b) Extension month to month. The lease continues after ${formatIsoDatePdf(i.endDate)} from month to month, on the same terms, at the last rental${maintenance} in section 6, `
    + `payable on the same day of each month. ${extensionEnd}`,
    "(c) Purchase at market value. The lessor sells the goods to the lessee at a price not less than their market value: the highest current valuation of the goods by an "
    + "independent assessor or dealer, dated within the period the lessor's valuation policy sets before the sale. The price is not fixed in this agreement, and nothing in "
    + "this agreement obliges either party to buy or sell the goods at any other price. Once the term has ended the lessor issues a tax invoice for the price plus VAT, which the "
    + `lessee pays within ${END_OF_TERM_PAYMENT_DAYS} days. Ownership passes, and the lessor signs the change of registration of a registered vehicle, only once the price and `
    + "everything else owing under this agreement have been paid. "
    + (i.cpa
      ? "The lessee has had the goods throughout the term and knows their condition; the sale does not limit the lessee's rights under the CPA."
      : "The goods are sold in the condition they are in at the end of the term, which the lessee knows, without any warranty by the lessor (voetstoots)."),
    i.cpa
      ? "If the lessee has made no choice by the expiry date and has not told the lessor to end the lease on that date, the lease continues month to month under (b), as "
        + `${s14Source(i, "2)(d")} provides, until it is ended as (b) provides.${s14Note(i, "2)(d", "the lessee")}`
      : "If the lessee has made no choice by the expiry date, it must return the goods on that date under clause 9.8. Until it does, the lessor may by written notice treat the "
        + "lease as extended under (b) from the expiry date.",
  )
}

/** The CPA variant's cancellation charge: the lessor's reasonable loss, crediting the returned goods (s14(3)(b)(ii), Reg 5(2)). */
export const CPA_CANCELLATION_CHARGE = "The cancellation penalty is the lessor's reasonable loss: (a) the present value, on the cancellation date, of the rentals (excl. VAT "
  + "and maintenance) that would have fallen due after it, discounted at the contract rate; less (b) the net amount the lessor realises, or can reasonably expect to "
  + "realise, by selling or letting the returned goods; plus (c) actual documented recovery, refurbishment and re-letting costs, itemised with their evidence. The charge is floored at zero and capped below the undiscounted remaining rentals, no percentage penalty is added, and it is determined having regard to regulation 5(2) of the CPA Regulations."

function earlyTermination(i: LeaseWordingInput): string {
  if (i.cpa) {
    return para(
      `The lessee may cancel this lease at any time by giving the lessor ${CPA_DAYS}' written notice, as ${s14Source(i, "2)(b)(i)(bb")} allows.${s14Note(i, "2)(b)(i)(bb", "the lessee")} The cancellation takes effect `
      + `${CPA_DAYS} after the notice is given, whether or not the lessee accepts or pays any quote. The rentals that would fall due after the cancellation date are `
      + "cancelled, and the goods are returned and inspected under clause 9.8 (the end-of-term invoice for usage and damage follows separately).",
      `The lessee remains liable for the amounts owed up to the cancellation date, and the lessor may charge only a reasonable cancellation penalty, as ${s14Source(i, "3")} provides. `
      + CPA_CANCELLATION_CHARGE,
      "The lessor gives the lessee a written quote stating the penalty, and invoices it, plus VAT, on the cancellation date. The lessee may dispute the amount with the "
      + "lessor, and may refer a dispute to the National Consumer Commission or a court; a dispute does not delay the cancellation.",
    )
  }
  const penalty = percentPdf(i.terms.earlyTerminationPenaltyRate)
  return para(
    "The lessee may end the lease before the end of the term only with the lessor's agreement, by asking for the lessor's early-termination quote and accepting it within "
    + "its validity. The termination date is the day the lessee accepts the quote.",
    "The amount is: (a) the present value, on the termination date, of the rentals (excl. VAT and maintenance) that would fall due after it, discounted at the "
    + `contract rate; plus (b) an early-termination penalty of ${penalty} of that present value; plus VAT on (a) and (b); plus (c) the arrears, including charges. `
    + "The lessor gives no credit for the resale value of the goods, which it keeps.",
    "The quote is valid for the period stated on it, and lapses if a rental is invoiced or changed before it is accepted. When the lessee accepts it, the rentals "
    + "falling due after the termination date are cancelled, (a) and (b) are invoiced on one tax invoice due on the termination date, and the goods are returned and inspected "
    + "under clause 9.8 (the end-of-term invoice for usage and damage follows separately).",
  )
}

function breach(i: LeaseWordingInput): string {
  const events = i.cpa
    ? `If the lessee fails to pay any amount on its due date or materially breaches this agreement, the lessor may give the lessee written notice of the breach. If the lessee `
      + `has not remedied it within ${CPA_DAYS} of the notice, the lessor may cancel this agreement, as ${s14Source(i, "2)(b)(ii")} provides, or exercise its other remedies `
      + `below.${s14Note(i, "2)(b)(ii", "the lessor", "the same right of cancellation as section 14(2)(b)(ii) gives a supplier")}`
    : "The lessee is in default if it: fails to pay any amount on its due date; breaches any other term and does not remedy the breach within "
      + `${COMMERCIAL_REMEDY_DAYS} days of the lessor's written notice; is placed under provisional or final sequestration, liquidation or deregistration, commits an act of `
      + "insolvency, or offers a compromise to its creditors; allows a judgment against it to stay unsatisfied for 7 days; allows the goods to be attached; or gave materially "
      + "false information to obtain this lease. A default by the lessee's surety is a default by the lessee. Business rescue proceedings are not of themselves a default; "
      + "while they last, section 133 of the Companies Act, 2008 limits the lessor's remedies."
  const costs = i.cpa
    ? "the legal costs a court awards or the lessee agrees to after the default"
    : "the legal costs on the scale as between attorney and own client, collection commission and tracing costs"
  const damages = i.cpa
    ? "the amounts owed up to the cancellation date and a reasonable cancellation penalty calculated as clause 9.10 provides"
    : "the arrears and, as damages, the present value on the cancellation date of the rentals in section 6 still to fall due for the rest of the term, discounted at the "
      + "contract rate"
  return para(
    events,
    "On a default the lessor may, without losing any other right: (a) claim every amount due and enforce this agreement; or (b) cancel this agreement, recover the goods "
    + `(through a court order if the lessee does not return them voluntarily) and claim ${damages}, together with the reasonable costs of recovering, storing, insuring, `
    + `valuing and selling the goods and ${costs}.`,
    "The lessor sells or lets the recovered goods for the best price reasonably obtainable, measured against an independent valuation. The net proceeds (after the costs "
    + "deducted from them) are credited to the lessee's account when received. Any surplus is refunded to the lessee; the lessee pays any shortfall on demand.",
  )
}

function defaultInterest(i: LeaseWordingInput): string {
  const margin = i.pricing.arrearsMarginRate
  const rate = margin === null ? null
    : new Prisma.Decimal(margin).isZero() ? "the contract rate" : `the contract rate plus ${percentPdf(margin)} a year`
  const fee = i.pricing.collectionFeeCents
  return para(
    rate === null
      ? "No default interest is charged on late payments (section 5)."
      : `The lessee pays default interest on every amount not paid on its due date, from the day after the due date until it is paid, at ${rate}, calculated daily on a `
        + "365-day year and charged monthly. Default interest is not charged on default interest or on fees.",
    fee > 0
      ? `A collection fee of ${formatZarPdf(fee)} is charged once for each rental not paid in full by the end of its due date.`
      : "No collection fee is charged (section 5).",
    "Each payment is applied first to default interest, then to collection fees and other charges, then to the rentals and other amounts due, oldest first, and then to "
    + "amounts not yet due.",
  )
}

function cession(): string {
  return para(
    "The lessor may cede its rights, delegate its obligations and transfer ownership of the goods to anyone, including a financier, without the lessee's consent, provided the "
    + "lessee's rights under this agreement are not reduced. On request the lessee acknowledges the cession in writing and pays the cessionary.",
    "The lessee may not cede, assign or delegate any right or obligation under this agreement, or sublet the goods, without the lessor's prior written consent.",
  )
}

function notices(i: LeaseWordingInput): string {
  return para(
    "Each party chooses as its address for legal process and notices (domicilium citandi et executandi): the lessor, its registered office in section 1; the lessee, its "
    + "address in section 2. A party may change its address by written notice to another physical address in the Republic.",
    "Notices must be in writing and may be delivered by hand to the chosen address or sent by email to an address the receiving party has given for notices. "
    + (i.cpa
      ? "Notices to the lessee are written in plain language (section 22 of the CPA)."
      : "A notice delivered by hand is presumed received on delivery, and one sent by email on the first business day after it is sent."),
    "A written notice actually received is valid even if it was not given as this clause provides.",
  )
}

function general(i: LeaseWordingInput): string {
  return para(
    "This agreement is the whole agreement between the parties about its subject. A variation, cancellation by agreement or waiver binds a party only if in writing and signed "
    + "by it. A relaxation or indulgence is not a waiver. If a provision is invalid, the rest of the agreement stands. South African law governs this agreement.",
    i.cpa
      ? "Nothing in this agreement limits any right the lessee has under the CPA, including in respect of representations made to it before it signed."
      : "The lessee consents to the jurisdiction of the Magistrates' Court under section 45 of the Magistrates' Courts Act, 1944, even if the amount claimed exceeds that "
        + "court's jurisdiction; the lessor may instead sue in any other competent court. A certificate signed by any manager of the lessor, whose appointment need not be "
        + "proved, stating the amount the lessee owes is prima facie proof of that amount.",
    "The lessor processes the personal information of the lessee and its representatives under the Protection of Personal Information Act, 2013, to conclude, administer and "
    + "enforce this agreement, and may share it for those purposes with its service providers, insurers, the supplier, its funders and any cessionary.",
    "This agreement may be signed electronically and in counterparts, as the Electronic Communications and Transactions Act, 2002 allows.",
  )
}

export function endClauses(i: LeaseWordingInput): WordingClause[] {
  return [
    { heading: "End-of-term options: return, extension or purchase at market value", text: endOptions(i) },
    { heading: "Early termination", text: earlyTermination(i) },
    { heading: "Breach and remedies", text: breach(i) },
    { heading: "Default interest and collection costs", text: defaultInterest(i) },
    { heading: "Cession and assignment", text: cession() },
    { heading: "Domicilium and notices", text: notices(i) },
    { heading: "General", text: general(i) },
  ]
}
