// Lease clauses 9.1–9.8: the goods, the rentals, VAT, insurance, use, usage
// and return (./lease-agreement.ts assembles them). Figures come from the
// lease terms the agreement already prints in sections 5–7.
import { Prisma } from "@prisma/client"
import { formatZarPdf } from "@/lib/pdf/helpers"
import { RATE_BASIS_LABELS } from "../../deal-labels"
import { END_OF_TERM_PAYMENT_DAYS } from "../../lease-periods"
import { REPRICE_NOTICE_DAYS } from "../../reprice"
import { percentPdf } from "../document-parts"
import { formatIsoDatePdf } from "../pdf-layout"
import type { LeaseWordingInput, WordingClause } from "./lease-agreement"

/** The s49 CPA notice that opens a clause placing risk or liability on a consumer lessee. */
export const CPA_S49_NOTICE = "IMPORTANT (section 49 of the CPA): this clause places risk or liability on the lessee. Read it carefully before signing."

/** Business days within which the lessee may object to the inspection report. */
export const INSPECTION_OBJECTION_BUSINESS_DAYS = 10

const para = (...parts: (string | false)[]): string => parts.filter((p): p is string => p !== false).join("\n\n")

function leaseOfGoods(i: LeaseWordingInput): string {
  return para(
    `${i.lessorName} ("the lessor") lets to ${i.lesseeName} ("the lessee") the goods described in section 3 ("the goods") for the term in section 5, `
    + `which starts on the commencement date, ${formatIsoDatePdf(i.startDate)}, and ends on ${formatIsoDatePdf(i.endDate)}, on the terms of this agreement. `
    + "Sections 1 to 8 form part of these terms.",
    "The goods remain the property of the lessor throughout. Nothing in this agreement transfers ownership to the lessee: the lessee becomes the owner only if it buys the goods "
    + "at their market value under clause 9.9(c). The lessee may not sell, let, lend, pledge or encumber the goods, or part with possession of them.",
    "Before the goods are brought onto premises the lessee does not own, the lessee must tell the owner of those premises in writing that the goods belong to the lessor, "
    + "and must give the lessor a copy of that notice on request. If anyone attaches or claims the goods, the lessee must tell that person that the lessor owns them, and tell the lessor at once.",
    "A registered vehicle is registered in the lessor's name as owner and titleholder. The lessee pays the licence and registration fees as they fall due and is liable for every "
    + "traffic fine and toll incurred while the goods are in its possession; the lessor may nominate the lessee, or its driver, as the person responsible for a fine.",
  )
}

function delivery(i: LeaseWordingInput): string {
  return para(
    i.cpa && CPA_S49_NOTICE,
    "The lessee chose the goods and the supplier named in section 4. The supplier delivers the goods to the lessee on the lessor's behalf. On delivery the lessee inspects the goods "
    + "and signs a delivery and acceptance certificate, which confirms that the goods described in section 3 were delivered; the lessor then pays the supplier. The lessee must not sign "
    + "the certificate before the goods have been delivered.",
    i.cpa
      ? "Nothing in this agreement limits the lessee's rights under sections 55 and 56 of the Consumer Protection Act, 2008 (\"the CPA\") to safe goods of good quality. "
        + "The lessor also makes the supplier's and the manufacturer's warranties available to the lessee for the term."
      : "The lessor gives no warranty about the condition, quality or fitness for purpose of the goods, and is not liable for a delay in delivery or for a defect, except where caused by its "
        + "own gross negligence or wilful misconduct. The lessor cedes to the lessee, for the term, its rights against the supplier and the manufacturer under their warranties, so that the "
        + "lessee may enforce them. A defect in the goods does not suspend the rentals.",
    "From delivery until the goods are returned to the lessor, the lessee bears the risk of the goods being lost, stolen, damaged or destroyed from any cause other than the lessor's "
    + "own gross negligence. A loss does not end the lessee's obligation to pay the rentals, except as clause 9.5 provides for goods stolen or written off.",
  )
}

function rentals(i: LeaseWordingInput): string {
  const t = i.terms
  const timing = t.rentalTiming === "ADVANCE"
    ? "monthly in advance, the first on the commencement date"
    : "monthly in arrears"
  const escalation = new Prisma.Decimal(t.escalationRate).isZero()
    ? "The rental does not escalate."
    : `The rental increases by ${percentPdf(t.escalationRate)} on each anniversary of the commencement date; the rentals in section 6 already include these increases.`
  const label = RATE_BASIS_LABELS[i.pricing.rateBasis]
  const rate = i.pricing.rateBasis === "FIXED"
    ? "The rentals are priced at the fixed contract rate in section 5 and do not change when interest rates change."
    : `The rentals are priced at the contract rate in section 5, which is linked to the ${label} rate. When that reference rate changes, the lessor recalculates the rentals `
      + `not yet invoiced that fall due at least ${REPRICE_NOTICE_DAYS} days after the recalculation, at the new contract rate (the new reference rate with the same margin). `
      + "The term and the number of rentals do not change, and neither does the maintenance part of a rental; a rental already invoiced never changes. "
      + "The lessor tells the lessee the new rentals in writing before the first changed rental falls due."
  return para(
    `The lessee pays the rentals in section 6 ${timing}, on their due dates, by debit order or electronic transfer into the account the lessor names in writing`
    + `${i.cpa ? "." : ", without deduction or set-off."} A payment counts only once the lessor receives it in cleared funds.`,
    escalation,
    rate,
  )
}

function vat(): string {
  return para(
    "Each rental is a separate supply. The lessor issues a tax invoice for each rental on the earlier of its due date and the day the lessor receives payment of it, "
    + "and charges VAT on the rental at the rate in force at that time (section 5 shows the rate at commencement).",
    "If the VAT rate changes, the rentals change by the difference in VAT, as section 67 of the Value-Added Tax Act, 1991 allows. Every other amount under this agreement "
    + "(an end-of-term, purchase or termination amount) is invoiced on its own tax invoice, with VAT where that Act requires it.",
  )
}

function insurance(i: LeaseWordingInput): string {
  return para(
    i.cpa && CPA_S49_NOTICE,
    "From delivery until the goods are returned, the lessee must keep the goods insured with an insurer of its choice registered under the Insurance Act, 2017, against loss, "
    + "theft, damage and destruction from any cause for their full replacement value, and against liability to third parties arising from their use. The policy must record the "
    + "lessor's interest as owner and first loss payee, and require the insurer to tell the lessor before the cover lapses or is cancelled. The lessee pays every premium and excess "
    + "and gives the lessor proof of cover on request. If the lessee does not insure the goods, the lessor may insure them and recover the premium from the lessee on demand.",
    "The lessee reports any loss or damage to the lessor and the insurer within 24 hours, and a theft or hijacking also to the South African Police Service, and does nothing that "
    + "could void the cover. Insurance proceeds for repairable damage are used to repair the goods.",
    "If the goods are stolen and not recovered, or written off, the lease ends on the day the insurer settles the claim. The lessee then pays the lessor the amount clause 9.10 "
    + "would give on that day, without the early-termination penalty, and the insurance proceeds the lessor receives are credited against it. The lessee has no claim to any "
    + "part of the proceeds above that amount.",
  )
}

function careAndUse(i: LeaseWordingInput): string {
  return para(
    i.cpa && CPA_S49_NOTICE,
    "The lessee must: use the goods carefully, for its business, within their rated capacity and according to the manufacturer's instructions; have them operated only by "
    + "competent operators who hold every licence and certificate the law requires; keep them in the Republic of South Africa, and not take them across its borders without the "
    + "lessor's written consent; tell the lessor in writing where the goods are kept and of any change; comply with every law that applies to their possession and use; and "
    + `${i.fml ? "present them for the maintenance the lessor arranges under clause 9.16" : "service and maintain them at its own cost as the manufacturer recommends, using genuine or equivalent parts"}.`,
    "Apart from fair wear and tear (clause 9.8), the lessee must keep the goods in the order and condition in which they were delivered. It may not alter them or add to them "
    + "without the lessor's written consent; a part or accessory fitted to the goods becomes the lessor's property without compensation unless it can be removed without damage "
    + "and is removed before the goods are returned. The lessor or its agent may inspect the goods at any reasonable time on reasonable notice.",
    "The lessee indemnifies the lessor against every claim by any person for loss, damage, injury or death arising from the possession, use or operation of the goods during "
    + "the term, except where caused by the lessor's gross negligence or wilful misconduct.",
  )
}

function usage(i: LeaseWordingInput): string {
  const u = i.terms.usage
  if (!u) {
    return "Section 7 records that no usage limit is contracted, so no excess-usage charge applies. The lessee must still use the goods reasonably under clause 9.6, "
      + "and damage beyond fair wear and tear is charged under clause 9.8."
  }
  const unit = u.unit === "HOURS" ? "hours" : "km"
  const one = u.unit === "HOURS" ? "hour" : "km"
  return para(
    `The contracted usage is ${u.allowancePerYear.toLocaleString("en-ZA")} ${unit} a year (section 7), pro rata over the months the lease runs. At the end of the term `
    + `the lessor charges, once, for the usage above it at ${formatZarPdf(u.excessRateCents)} per ${one} excl. VAT, plus VAT. The excess is the final reading less the reading `
    + `at commencement, less the contracted usage multiplied by the number of months for which rentals fell due and divided by 12. An extension adds months and an early `
    + "termination ends them. The charge is on the end-of-term tax invoice (clause 9.8). Using less than the contracted usage earns no credit.",
    `The lessee must keep the ${u.unit === "HOURS" ? "hour meter" : "odometer"} working and must not disconnect, alter or tamper with it. It may record readings through the `
    + "lessor's portal, and must tell the lessor at once if the meter fails or is replaced and have it repaired. The lessor may also take readings when it inspects the goods. "
    + "No reading may be lower than an earlier one. The final reading is taken at the end-of-term inspection.",
  )
}

function returnOfGoods(i: LeaseWordingInput): string {
  const fundDeficit = i.fml && i.terms.maintenance?.riskModel === "LESSEE_SETTLED" ? ", any maintenance fund deficit (clause 9.16)" : ""
  return para(
    "When the lease ends (on expiry, at the end of an extension, on early termination or on cancellation), unless the lessee buys the goods under clause 9.9(c), the lessee must "
    + "at its own cost return the goods, with their keys, manuals, accessories, service records and registration documents, clean and in good working order apart from fair "
    + "wear and tear, to the place in the Republic the lessor reasonably names. Until the goods are returned the lessee remains bound by this agreement, including clauses 9.2 and 9.5.",
    "The lessor inspects the goods on or after the day the lease ends. Its inspection report records their condition, each item of damage with its assessed cost of repair "
    + "excl. VAT, and the final meter reading. The lessee may attend the inspection and receives a copy of the report.",
    "\"Fair wear and tear\" is the deterioration that results from normal use of the goods for their purpose, within the contracted usage, with the care and maintenance this "
    + "agreement requires. It does not include accident or impact damage, missing or broken parts or glass, damage from misuse, overloading or neglect, unauthorised alterations, "
    + "or damage the insurance under clause 9.5 covers or should have covered.",
    `The lessor issues one end-of-term tax invoice for the excess usage (clause 9.7), the assessed damage${fundDeficit} and VAT. The lessee pays it within `
    + `${END_OF_TERM_PAYMENT_DAYS} days of the invoice date. The lessee may object to an item in writing, with reasons, within ${INSPECTION_OBJECTION_BUSINESS_DAYS} business days `
    + "of receiving the report; the lessor considers the objection in good faith and, if it upholds it, issues a credit note. An objection does not suspend payment of the "
    + "items not in dispute.",
  )
}

export function goodsClauses(i: LeaseWordingInput): WordingClause[] {
  return [
    { heading: "Lease of the goods; ownership remains with the lessor", text: leaseOfGoods(i) },
    { heading: "Delivery, acceptance and risk", text: delivery(i) },
    { heading: "Rentals, escalation and changes to the contract rate", text: rentals(i) },
    { heading: "Tax invoices and VAT", text: vat() },
    { heading: "Insurance of the goods", text: insurance(i) },
    { heading: "Use, care and location of the goods", text: careAndUse(i) },
    { heading: "Contracted usage and excess-usage charges", text: usage(i) },
    { heading: "Return of the goods and the end-of-term inspection", text: returnOfGoods(i) },
  ]
}
