// Wording of the three lease servicing documents (../lease/*-pdf.ts), drafted
// for the lender's legal team to review: the CPA expiry notice (what happens
// if the lessee does nothing), the end-of-term inspection report (fair wear
// and tear, how damage and excess usage are charged, how to object) and the
// early-termination quote (what accepting means; the CPA s14 / Reg 5(2)
// position of a consumer lessee, or the commercial position). The figures
// are the row's; the periods are the code's.
import { formatZarPdf } from "@/lib/pdf/helpers"
import { END_OF_TERM_PAYMENT_DAYS } from "../../lease-periods"
import { CPA_CANCELLATION_NOTICE_BUSINESS_DAYS } from "../../lease-termination"
import { formatIsoDatePdf } from "../pdf-layout"
import type { ExpiryNoticeData, InspectionReportData, TerminationQuoteData } from "../lease/lease-docs-types"
import type { WordingClause } from "./lease-agreement"
import { INSPECTION_OBJECTION_BUSINESS_DAYS } from "./lease-agreement-goods"

const para = (...parts: (string | false)[]): string => parts.filter((p): p is string => p !== false).join("\n\n")
const months = (n: number): string => (n === 1 ? "one month's" : `${n} months'`)

export const FAIR_WEAR_AND_TEAR = "\"Fair wear and tear\" is the deterioration that results from normal use of the goods for their purpose, within the contracted usage, "
  + "with the care and maintenance the lease agreement requires. It does not include accident or impact damage, missing or broken parts or glass, damage from misuse, "
  + "overloading or neglect, unauthorised alterations, or damage the lessee's insurance covers or should have covered."

export function expiryNoticeClauses(data: ExpiryNoticeData): WordingClause[] {
  const expiry = formatIsoDatePdf(data.expiryDate)
  return [
    {
      heading: "Consequences of taking no action before the expiry date",
      text: para(
        `If you have not told us your choice by ${expiry}, your lease does not simply end. Section 14(2)(d) of the Consumer Protection Act, 2008 provides that it then `
        + "continues month to month after the expiry date. It continues on the same terms, at the same monthly rental (and maintenance, if your lease includes it) as your "
        + "last rental: no material change applies to the continued lease.",
        "While it continues you keep the goods, pay the rental each month, and keep the goods insured and in good condition as your lease agreement requires. Either of us may "
        + `end the month-to-month lease by giving ${months(data.extensionNoticeMonths)} written notice; you then return the goods, which are inspected, and any damage beyond `
        + "fair wear and tear and any usage above the contracted usage are invoiced.",
        `If you do not want the lease to continue, tell us in writing before ${expiry} that it must end on that date, and return the goods to us on or before then.`,
      ),
    },
    {
      heading: "How to tell us your choice",
      text: "Tell us your choice through our client portal, or by email or telephone using the contacts in section 5. Your choice is final once we have recorded it, "
        + "and we confirm it to you in writing.",
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
  return [
    {
      heading: "What accepting this quote means",
      text: para(
        `If you accept this quote, your lease ends on ${on}. The ${data.remainingRentals} rental${data.remainingRentals === 1 ? "" : "s"} that would fall due after that date `
        + "are cancelled. You return the goods on that date; they are inspected, and any damage beyond fair wear and tear, any usage above the contracted usage and, on a "
        + "full-maintenance lease, the settlement of the maintenance fund are invoiced separately on the end-of-term tax invoice. They are not part of this quote.",
        `On acceptance the lessor issues one tax invoice for the present value and the penalty, plus VAT, due on ${on}. The arrears are already due. Default interest runs `
        + "on any amount not paid by its due date, as the lease agreement provides. If a rental is invoiced or changed before you accept, this quote can no longer be "
        + "accepted and a new quote is needed.",
      ),
    },
    data.cpaCancellation
      ? {
        heading: "Your rights under the Consumer Protection Act",
        text: para(
          `You are a consumer under the Consumer Protection Act, 2008. Section 14(2)(b)(i)(bb) allows you to cancel your lease on ${CPA_CANCELLATION_NOTICE_BUSINESS_DAYS} `
          + `business days' notice. This quote treats your request as that notice, so the termination date is ${CPA_CANCELLATION_NOTICE_BUSINESS_DAYS} business days after `
          + `${formatIsoDatePdf(data.quotedOn)}; the cancellation takes effect if you accept the quote.`,
          "Under section 14(3) you remain liable for the amounts owed up to the termination date, and the lessor may charge only a reasonable cancellation penalty. "
          + "The present value and the penalty together are that penalty, and must be reasonable under regulation 5(2) of the CPA Regulations, which weighs the factors "
          + "named in section 4.",
          "If you believe the amount is not reasonable, tell the lessor before you accept, using the contacts in section 6. You may also complain to the National "
          + "Consumer Commission.",
        ),
      }
      : {
        heading: "Basis of early termination",
        text: "Your lease agreement does not give you a right to end the lease early. This quote is the lessor's offer to end it by agreement, on the terms of the "
          + "early-termination clause of the lease agreement, with the termination date on the day the quote was given.",
      },
  ]
}
