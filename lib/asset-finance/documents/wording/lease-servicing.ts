// Wording of the three lease servicing documents (../lease/*-pdf.ts), DRAFT
// for the lender's legal team (the rules behind it are signed off: see
// DESIGN.md sign-off record 2026-10-17): the CPA expiry notice (what happens
// if the lessee does nothing), the end-of-term inspection report (fair wear
// and tear, how damage and excess usage are charged, how to object) and the
// early-termination quote (a CPA lessee's s14 cancellation and its charge, or
// the commercial offer to end by agreement). The figures are the row's; the
// periods are the code's. Code gaps: docs/asset-finance/legal-wording/README.md.
import { formatZarPdf } from "@/lib/pdf/helpers"
import { END_OF_TERM_PAYMENT_DAYS } from "../../lease-periods"
import { CPA_CANCELLATION_NOTICE_BUSINESS_DAYS } from "../../lease-termination"
import { formatIsoDatePdf } from "../pdf-layout"
import type { ExpiryNoticeData, InspectionReportData, TerminationQuoteData } from "../lease/lease-docs-types"
import type { WordingClause } from "./lease-agreement"
import { CPA_CANCELLATION_CHARGE, s14Note, s14Source } from "./lease-agreement-end"
import { INSPECTION_OBJECTION_BUSINESS_DAYS } from "./lease-agreement-goods"

const para = (...parts: (string | false)[]): string => parts.filter((p): p is string => p !== false).join("\n\n")
const months = (n: number): string => (n === 1 ? "one month's" : `${n} months'`)

export const FAIR_WEAR_AND_TEAR = "\"Fair wear and tear\" is the deterioration that results from normal use of the goods for their purpose, within the contracted usage, "
  + "with the care and maintenance the lease agreement requires. It does not include accident or impact damage, missing or broken parts or glass, damage from misuse, "
  + "overloading or neglect, unauthorised alterations, or damage the lessee's insurance covers or should have covered."

export function expiryNoticeClauses(data: ExpiryNoticeData): WordingClause[] {
  const expiry = formatIsoDatePdf(data.expiryDate)
  const days = `${CPA_CANCELLATION_NOTICE_BUSINESS_DAYS} business days`
  return [
    {
      heading: "Consequences of taking no action before the expiry date",
      text: para(
        `If you have not told us your choice by ${expiry}, your lease does not simply end. As ${s14Source(data, "2)(d")} provides, it then `
        + `continues month to month after the expiry date.${s14Note(data, "2)(d", "you")} It continues `
        + "on the same terms, at the same monthly rental (and maintenance, if your lease includes it) as your "
        + "last rental: no material change applies to the continued lease.",
        "While it continues you keep the goods, pay the rental each month, and keep the goods insured and in good condition as your lease agreement requires. You may end "
        + `the month-to-month lease at any time by giving us at least ${days}' written notice; it ends on the date in your notice, not earlier than ${days} after it. We may `
        + `end it by giving you ${months(data.extensionNoticeMonths)} written notice. You then return the goods, which are inspected, and any damage beyond `
        + "fair wear and tear and any usage above the contracted usage are invoiced.",
        `If you do not want the lease to continue, tell us in writing before ${expiry} that it must end on that date, and return the goods to us on or before then.`,
      ),
    },
    {
      heading: "How to tell us your choice",
      text: "Tell us your choice through our client portal, or by written notice to us, which may be sent by email to the address in section 5. Your choice is final once "
        + "we have recorded it, and we confirm it to you in writing.",
    },
  ]
}

export function inspectionReportClauses(data: InspectionReportData): WordingClause[] {
  const early = data.origin === "EARLY_TERMINATION"
  const usage = data.excessUsageCents === null
    ? "The excess-usage charge is calculated when the end-of-term invoice is issued, from the final reading in section 3"
    : `The excess-usage charge in section 5 (${formatZarPdf(data.excessUsageCents)} excl. VAT) was calculated from the final reading in section 3`
  return [
    { heading: "Fair wear and tear", text: `Damage is charged only where it goes beyond fair wear and tear. ${FAIR_WEAR_AND_TEAR}` },
    {
      heading: "How the damage is assessed",
      text: "Each item in section 4 is the lessor's assessed cost, excl. VAT, of repairing the damage or, where a repair is not economical, of replacing the damaged part, "
        + "at the date of the inspection.",
    },
    {
      heading: "How excess usage is charged",
      text: `${usage}: the final reading less the reading at the start of the lease, less the contracted usage a year multiplied by the number of months for which `
        + `rentals fell due and divided by 12, at the excess-usage rate in the lease agreement.${early ? " Because the lease ended early, only the months to the termination date count." : ""} `
        + "Using less than the contracted usage earns no credit.",
    },
    {
      heading: "Invoice and payment",
      text: "The amounts in section 5, plus VAT, and any other end-of-term amount the lease agreement provides for (such as the settlement of a maintenance fund), are "
        + `charged on one end-of-term tax invoice, which is payable within ${END_OF_TERM_PAYMENT_DAYS} days of its date.`,
    },
    {
      heading: "If you disagree with this report",
      text: `You may object to any item in writing, with reasons, within ${INSPECTION_OBJECTION_BUSINESS_DAYS} business days of receiving this report, using the contacts `
        + "in section 7. The lessor considers the objection in good faith and, if it upholds it, issues a credit note. An objection does not suspend payment of the items "
        + "not in dispute.",
    },
  ]
}

export function terminationQuoteClauses(data: TerminationQuoteData): WordingClause[] {
  const on = formatIsoDatePdf(data.terminationDate)
  const rentals = (day: string) => `The ${data.remainingRentals} rental${data.remainingRentals === 1 ? "" : "s"} that would fall due after ${day} are cancelled.`
  const goods = (day: string) => `You return the goods on ${day}; they are inspected, and any damage beyond fair wear and tear, any usage above the contracted usage and, `
    + "on a full-maintenance lease, the settlement of the maintenance fund are invoiced separately on the end-of-term tax invoice. They are not part of this quote."
  if (data.cpaCancellation) {
    return [
      {
        heading: "Your cancellation",
        text: para(
          `You gave us notice on ${formatIsoDatePdf(data.quotedOn)} to cancel your lease, as ${s14Source(data, "2)(b)(i)(bb")} allows on `
          + `${CPA_CANCELLATION_NOTICE_BUSINESS_DAYS} business days' notice.${s14Note(data, "2)(b)(i)(bb", "you")} Your lease therefore ends on ${on}, whether or not you accept or pay this quote. ${rentals("that date")} ${goods("that date")}`,
        ),
      },
      {
        heading: "The cancellation charge",
        text: para(
          `You remain liable for the amounts owed up to ${on}, and the lessor may charge only a reasonable cancellation penalty, as ${s14Source(data, "3")} provides. `
          + `This quote states that charge. ${CPA_CANCELLATION_CHARGE}`,
          `The lessor issues one tax invoice for the charge, plus VAT, due on ${on}. The arrears are already due. Default interest runs on any amount not paid by its due `
          + "date, as the lease agreement provides.",
        ),
      },
      {
        heading: "If you disagree with the charge",
        text: "Tell the lessor, using the contacts in section 6. You may also refer a dispute to the National Consumer Commission or a court. A dispute does not delay "
          + "your cancellation.",
      },
    ]
  }
  return [
    {
      heading: "What accepting this quote means",
      text: para(
        `If you accept this quote within its validity, your lease ends on the day you accept it. ${rentals("that day")} ${goods("that day")}`,
        "On acceptance the lessor issues one tax invoice for the present value and the penalty, plus VAT, due on the day you accept. The arrears are already due. Default "
        + "interest runs on any amount not paid by its due date, as the lease agreement provides. If a rental is invoiced or changed before you accept, this quote can no "
        + "longer be accepted and a new quote is needed.",
      ),
    },
    {
      heading: "Basis of early termination",
      text: "Your lease agreement does not give you a right to end the lease early. This quote is the lessor's offer to end it by agreement, on the terms of the "
        + "early-termination clause of the lease agreement, with the termination date on the day you accept it.",
    },
  ]
}
