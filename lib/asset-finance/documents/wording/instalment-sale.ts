// The instalment sale agreement's clauses (./../agreement-pdf.ts section 7).
// DRAFT wording for the lender's legal team (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17):
// the DRAFT watermark prints until TenantConfig.assetFinanceLegalWordingApproved. Only for a juristic
// purchaser outside the NCA: an NCA deal is refused this document
// (deal-document-data.ts, nca-entity-signing.ts renders the NCA agreement).
// Every figure is the deal's own data, printed in sections 1 to 6.
// Notes and sources: docs/asset-finance/legal-wording/commercial.md.
import { Prisma } from "@prisma/client"
import { formatZarPdf } from "@/lib/pdf/helpers"
import type { DealDocumentData } from "../deal-document-data"
import { percentPdf } from "../document-parts"
import { formatIsoDatePdf } from "../pdf-layout"
import { contractRateFormula, referenceDefinition, type WordingClause } from "./commercial-common"
import { cpaInstalmentSaleClauses } from "./instalment-sale-cpa"
import { instalmentSaleEnforcementClauses } from "./instalment-sale-enforcement"

function saleAndOwnership(): WordingClause {
  return {
    heading: "Sale of the goods and ownership",
    text: `The seller in section 1 ("the Seller") sells to the purchaser in section 2 ("the Purchaser"), and the Purchaser buys, the goods described in section 3 ("the Goods") on the terms of this agreement ("this Agreement"). This Agreement is an instalment sale: the price is paid in the payments set out in the repayment schedule in section 6 ("the Schedule").

Ownership of the Goods stays with the Seller until the Purchaser has paid every amount owing under this Agreement, including the final payment of the Schedule and any amount owing under clauses 7.8 and 7.9. Ownership then passes to the Purchaser without any further act. Until then the Purchaser may not sell, let, lend, pledge or encumber the Goods or part with possession of them, and must not allow any lien, attachment or hypothec to arise over them.

The Purchaser chose the Goods and the supplier in section 4 ("the Supplier") itself. The Seller buys the Goods from the Supplier only to sell them to the Purchaser, is not the Supplier's agent, and gives no warranty about the condition, quality or fitness for purpose of the Goods. For as long as the Purchaser is not in breach of this Agreement, the Seller cedes to the Purchaser every warranty and claim it has against the Supplier or the manufacturer in respect of the Goods. A defect in the Goods, or a dispute with the Supplier, does not suspend or reduce any obligation of the Purchaser under this Agreement.

If the Goods are to be kept on premises the Purchaser does not own, the Purchaser must, before the Goods are brought there, notify the owner of the premises in writing that the Seller owns the Goods, and give the Seller a copy of that notice. The Goods must not be attached to land or to any other thing in a way that could transfer ownership of them by accession.

To the extent that the Consumer Protection Act 68 of 2008 applies to this Agreement or to the Goods, nothing in this Agreement limits any right the Purchaser has under that Act, including sections 55 and 56.`,
  }
}

function deliveryAndRisk(): WordingClause {
  return {
    heading: "Delivery, acceptance and risk",
    text: `The Supplier delivers the Goods to the Purchaser at the Purchaser's cost. On delivery the Purchaser must inspect the Goods and sign a delivery and acceptance certificate confirming that the Goods, with the identifying numbers shown in section 3, were delivered complete and in good order. The Seller pays the Supplier only after it has received that certificate and the other documents it requires for payment, and is not liable for any delay in delivery or for any failure of the Supplier to deliver.

All risk of loss, theft, damage or destruction of the Goods, from any cause, passes to the Purchaser on delivery and stays with it until ownership passes under clause 7.1. No loss, theft, damage or destruction releases the Purchaser from any obligation under this Agreement.

The Purchaser indemnifies the Seller against every claim by any person arising from the possession, use or operation of the Goods.`,
  }
}

function payment(data: DealDocumentData): WordingClause {
  const p = data.pricing
  const last = data.schedule.at(-1)
  const balloon = p.balloonCents > 0 && last
    ? ` The payment due on ${formatIsoDatePdf(last.dueDate)} includes the balloon of ${formatZarPdf(p.balloonCents)}.`
    : ""
  return {
    heading: "Payment",
    text: `The Purchaser must pay the deposit shown in section 5, to the Supplier or to the Seller as the Seller directs, before the Seller pays the Supplier, and each payment in the Schedule in full on its due date.${balloon} Payments are made by debit order or by electronic transfer into the bank account the Seller designates in writing, without any deduction or set-off, and count as paid only when the Seller receives them in cleared funds.

The Seller applies every amount it receives under this Agreement in this order: first to default interest under clause 7.9; then to interest due under clause 7.4; then to collection fees under clause 7.9; then to any other fees and charges due; then to capital due; and last to payments not yet due, in the order of their due dates.

The Seller issues a tax invoice for the cash price of the Goods including value-added tax, as shown in section 5. Interest under this Agreement is consideration for an exempt financial service under sections 2 and 12(a) of the Value-Added Tax Act 89 of 1991. Any fee under this Agreement bears value-added tax where that Act requires it.`,
  }
}

function interest(data: DealDocumentData): WordingClause {
  const p = data.pricing
  const accrual = `Interest accrues daily on the outstanding capital at the contract rate ("the Contract Rate"), calculated on the actual number of days elapsed in a year of 365 days, and is payable as part of each payment in the Schedule.`
  if (p.rateBasis === "FIXED") {
    return { heading: "Interest and changes to the contract rate", text: `${accrual}

The Contract Rate is ${contractRateFormula(p)}. It does not change during the term of this Agreement.` }
  }
  const label = contractRateFormula(p)
  const reference = p.reference
    ? ` On the schedule start date the reference rate is ${percentPdf(p.reference.rate)} (effective ${formatIsoDatePdf(p.reference.effectiveDate)}), so the Contract Rate is ${percentPdf(p.annualRate)} a year (nominal).`
    : ` On the schedule start date the Contract Rate is ${percentPdf(p.annualRate)} a year (nominal).`
  return {
    heading: "Interest and changes to the contract rate",
    text: `${accrual}

The Contract Rate is linked to a reference rate: it is ${label}.${reference} ${referenceDefinition(p.rateBasis) ?? ""}

Whenever the reference rate changes, the Contract Rate changes by the same number of percentage points with effect from the date on which the changed reference rate takes effect, and clause 7.5 applies. The margin ${new Prisma.Decimal(p.rateMargin ?? "0").isNegative() ? "below" : "above"} the reference rate does not change during the term of this Agreement.`,
  }
}

function commencement(data: DealDocumentData): WordingClause {
  const p = data.pricing
  const recalculation = p.rateBasis === "FIXED"
    ? "Because the Contract Rate is fixed, the Schedule is not recalculated for any change in interest rates."
    : `When the Contract Rate changes under clause 7.4, the Seller recalculates the payments falling due after the change so that the number of payments, their due dates, their relative sizes under the repayment structure in section 5, and the balloon all stay the same, and the outstanding capital is repaid at the new Contract Rate by the last due date. Interest at the new Contract Rate accrues from the date of the change. The Seller notifies the Purchaser in writing of the new payment amounts. The Seller may keep a payment that falls due before that notice reaches the Purchaser at its previous amount; the resulting difference in interest is carried in the balance and spread over the recalculated payments. The recalculated payments replace those in section 6 from the date of the change.`
  return {
    heading: "Commencement and recalculation of the schedule",
    text: `This Agreement binds the parties once both have signed it. The Schedule runs from the schedule start date shown in section 5, ${formatIsoDatePdf(p.startDate)}, by which date the Seller intends to pay the Supplier, and interest accrues from that date.

If the Seller has not paid the Supplier by the schedule start date, for any reason, or if the Contract Rate in force on that date differs from the rate shown in section 5, the Seller may cancel this Agreement by written notice to the Purchaser. Neither party then has any claim against the other under this Agreement, except that the Seller must repay any amount the Purchaser paid to the Seller under it. The parties may then conclude a new agreement with a new schedule.

${recalculation}`,
  }
}

function insurance(): WordingClause {
  return {
    heading: "Insurance of the goods",
    text: `From delivery until ownership passes, the Purchaser must at its own cost keep the Goods comprehensively insured, for their full replacement value, with an insurer registered under the Insurance Act 18 of 2017 and acceptable to the Seller, against loss, theft, damage, fire and the other risks usually insured for goods of their kind, and against third-party liability where the Goods are used on public roads. The Seller's interest as owner must be noted on the policy, with the Seller as first loss payee.

The Purchaser must give the Seller proof of the insurance before the Seller pays the Supplier and proof of renewal on request, pay every premium on time, and do nothing that could entitle the insurer to avoid or reduce a claim. The Purchaser cedes to the Seller all its rights under the policy to the extent of the Seller's interest.

If the Purchaser does not insure the Goods as this clause requires, the Seller may (but need not) insure them, and the Purchaser must repay the premium on demand.

The Purchaser must report any loss, theft or damage to the Seller and to the insurer within 48 hours of becoming aware of it. The Seller applies insurance proceeds it receives to the repair or replacement of the Goods or, after a total loss and at its choice, towards the amounts owing under this Agreement, and pays any surplus to the Purchaser.`,
  }
}

function goodsUseAndLocation(data: DealDocumentData): WordingClause {
  const where = data.entity.addressLines.length > 0 ? `at the Purchaser's address in section 2 (${data.entity.addressLines.join(", ")})` : "at the Purchaser's address notified to the Seller in writing"
  return {
    heading: "Use, maintenance and location of the goods",
    text: `The Purchaser must use the Goods carefully, lawfully and only for its business, operated by competent and, where the law requires it, licensed operators, and within the limits the manufacturer specifies.

The Purchaser must at its own cost keep the Goods in good order and repair, have them serviced as the manufacturer's service schedule requires, keep the service records and show them to the Seller on request, and keep every licence, registration and roadworthy certificate the Goods need. Where the Goods are registrable, the Seller is recorded as titleholder and the Purchaser as owner. The Purchaser may not alter the Goods, or remove or change any identifying number on them, without the Seller's written consent.

The Purchaser must keep the Goods ${where}, or at another place in the Republic of South Africa that it has notified to the Seller in writing beforehand, and may not take them out of the Republic without the Seller's written consent. The Seller may inspect the Goods at any reasonable time on reasonable notice. If the Seller requires it, the Purchaser must at its cost have a tracking device fitted to the Goods and keep its subscription active until ownership passes.

The Purchaser must immediately notify the Seller in writing if any person attaches or claims the Goods, and must tell that person that the Seller owns them.`,
  }
}

/** Clauses 7.1 to 7.13 in printed order. */
export function instalmentSaleClauses(data: DealDocumentData): WordingClause[] {
  const clauses = [
    saleAndOwnership(),
    deliveryAndRisk(),
    payment(data),
    interest(data),
    commencement(data),
    insurance(),
    goodsUseAndLocation(data),
    ...instalmentSaleEnforcementClauses(data),
  ]
  return data.isaCpaApplies !== false ? cpaInstalmentSaleClauses(clauses) : clauses
}
