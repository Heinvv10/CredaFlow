// The instalment sale agreement's clauses 7.8 to 7.13: breach, charges,
// settlement, cession, notices and general. DRAFT wording for the lender's
// legal team (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17); see ./instalment-sale.ts.
// The charges follow ../../non-nca-charges.ts and the recovery rules
// ../../recovery-*.ts. The Settlement Amount is defined as the law allows
// (capital and interest accrued to date); lib/loan/settlement.ts still quotes
// the unrebated future payments: docs/asset-finance/legal-wording/README.md.
import { Prisma } from "@prisma/client"
import { formatZarPdf } from "@/lib/pdf/helpers"
import type { DealDocumentData } from "../deal-document-data"
import { percentPdf } from "../document-parts"
import { addressOrFallback, type WordingClause } from "./commercial-common"

function breach(): WordingClause {
  return {
    heading: "Breach and remedies",
    text: `Each of the following is an event of default: (a) the Purchaser fails to pay any amount on its due date and does not pay it within 7 days after the Seller's written demand; (b) the Purchaser breaches any other term of this Agreement and does not remedy the breach within 14 days after the Seller's written demand; (c) the Purchaser is placed in liquidation, is sequestrated or deregistered, or (for a trust or partnership) is dissolved or its trustees or partners lose their authority to act, or it compromises or tries to compromise with its creditors generally; (d) a judgment against the Purchaser remains unsatisfied for 7 days; (e) any information the Purchaser or a surety gave the Seller in connection with this Agreement was materially incorrect; (f) a surety for the Purchaser's obligations dies, is sequestrated, or disputes the suretyship; (g) the Goods are lost, attached, or removed from the Republic of South Africa without the Seller's written consent. Business rescue proceedings are not of themselves an event of default; while they last, section 133 of the Companies Act 71 of 2008 limits the Seller's remedies.

On an event of default the Seller may, without limiting any other right it has by law: (a) claim immediate payment of the Settlement Amount under clause 7.10 and every other amount owing; or (b) cancel this Agreement, take possession of the Goods, and claim as damages the Settlement Amount on the date of cancellation, together with the costs under clause 7.9, less the net proceeds of the Goods credited under this clause. The Seller takes possession of the Goods only with the Purchaser's written consent given at that time or under an order of court.

The Purchaser may, with the Seller's written consent, return the Goods to the Seller voluntarily. Returning the Goods does not by itself end the Purchaser's liability under this Agreement.

When the Seller has possession of the Goods after an event of default or a voluntary return, it may sell them by public auction or private treaty for the best price reasonably obtainable after a valuation. The net proceeds (the price less the costs of recovery, storage, transport, valuation, repair and sale that the Seller deducts from them) are credited to the Purchaser's account on the date they are applied, against the amount then owing. The Purchaser must pay any shortfall on demand, and the Seller pays any surplus to the Purchaser. While it recovers and sells the Goods the Seller may, without waiving any right, suspend the default interest and collection fees under clause 7.9.

Cancellation does not affect the Seller's right to amounts that fell due before it. The Seller keeps the payments it has received; they have already reduced the capital counted in the Settlement Amount.`,
  }
}

function charges(data: DealDocumentData): WordingClause {
  const p = data.pricing
  const margin = p.arrearsMarginRate === null ? null : new Prisma.Decimal(p.arrearsMarginRate)
  const defaultInterest = margin === null
    ? "No default interest is charged on overdue amounts under this Agreement."
    : `If a payment is not paid in full on its due date, the Purchaser pays default interest on the overdue amount (the unpaid capital and unpaid interest of every payment past its due date) from the day after the due date until it is paid, at ${margin.isZero() ? "the Contract Rate in force from time to time" : `the Contract Rate in force from time to time plus ${percentPdf(p.arrearsMarginRate ?? "0")} a year`}. Default interest is calculated daily on the actual number of days elapsed in a year of 365 days and is debited monthly. No default interest is charged on fees, collection fees, costs or default interest. As the common-law in duplum rule requires, interest in arrears stops running while the unpaid interest equals the unpaid capital.`
  const fee = p.collectionFeeCents > 0
    ? `For each payment that remains unpaid at the end of its due date, the Purchaser pays a collection fee of ${formatZarPdf(p.collectionFeeCents)}, including any value-added tax, which is debited on the day after the due date.`
    : "No collection fee is charged for a missed payment."
  return {
    heading: "Default interest and collection costs",
    text: `${defaultInterest}

${fee}

The Purchaser must pay, on demand, all legal costs the Seller incurs in enforcing this Agreement, on the scale as between attorney and own client, and all tracing, collection, recovery, storage, transport, valuation, repair and sale costs the Seller reasonably incurs because of an event of default. The Seller may deduct those costs from sale proceeds under clause 7.8 or debit them to the Purchaser's account.`,
  }
}

function earlySettlement(): WordingClause {
  return {
    heading: "Early settlement",
    text: `The Purchaser may settle this Agreement at any time by paying the Settlement Amount. On request the Seller gives the Purchaser a written settlement quotation stating the Settlement Amount on a date.

The "Settlement Amount" on a date is the total of: (a) every amount due and unpaid on that date, including default interest, collection fees and costs; (b) the capital outstanding on that date, including the capital of the balloon; and (c) the interest accrued on that capital from the last due date to that date at the Contract Rate. Interest that has not yet accrued is not payable, and no early-settlement fee is charged.

Ownership of the Goods passes to the Purchaser under clause 7.1 when the Seller receives the Settlement Amount in cleared funds.`,
  }
}

function cession(): WordingClause {
  return {
    heading: "Cession and assignment",
    text: `The Seller may cede, assign, sell or pledge any or all of its rights under this Agreement, delegate any of its obligations, and transfer its ownership of the Goods, to any person, without the Purchaser's consent and without splitting its claims being an objection. The Seller may disclose information about this Agreement and the Purchaser to any prospective cessionary or funder that undertakes to keep it confidential.

The Purchaser may not cede, assign, delegate or otherwise transfer any right or obligation under this Agreement, or let the Goods or part with possession of them, without the Seller's prior written consent.`,
  }
}

function notices(data: DealDocumentData): WordingClause {
  const seller = data.lender.registeredOfficeLines.join(", ")
  const purchaser = addressOrFallback(data.entity.addressLines, "the physical address it notifies to the Seller in writing before signing")
  return {
    heading: "Domicilium and notices",
    text: `The parties choose the following addresses as their domicilium citandi et executandi, where notices and legal process may be delivered: the Seller, its registered office at ${seller}; the Purchaser, ${purchaser}. A party may change its domicilium to another physical address in the Republic of South Africa by written notice to the other, effective 7 days after the notice is received.

A notice under this Agreement must be in writing. A notice delivered by hand to a party's domicilium is received on delivery; one sent by prepaid registered post to it is received on the 7th business day after posting; and one sent by email to an address the receiving party has designated in writing for notices is received on the business day after it is sent. A notice actually received is effective even if it was not delivered in one of these ways. "Business day" means any day other than a Saturday, Sunday or public holiday in South Africa.`,
  }
}

function general(): WordingClause {
  return {
    heading: "General",
    text: `This Agreement, with its sections 1 to 6, is the whole agreement between the parties about its subject matter. No variation, addition or cancellation of it, and no waiver of any right under it, has any effect unless it is in writing and signed by both parties, except a recalculation under clause 7.5 or a notice under clause 7.12. No indulgence or delay by the Seller is a waiver of any right or prevents it from enforcing any right later.

A certificate signed by any manager of the Seller, whose appointment need not be proved, stating the amount the Purchaser owes under this Agreement and that it is due, is prima facie proof of its contents for all purposes, including summary judgment and provisional sentence.

The Purchaser consents, under section 45 of the Magistrates' Courts Act 32 of 1944, to the jurisdiction of any magistrate's court having jurisdiction over it in any proceedings arising from this Agreement, even if the amount claimed exceeds that court's jurisdiction. The Seller may instead bring proceedings in any other competent court. This Agreement is governed by the law of the Republic of South Africa.

Each person who signs this Agreement for the Purchaser warrants that they are authorised to do so by a resolution of the Purchaser. If any provision of this Agreement is unenforceable, the remaining provisions stay in force.

The Purchaser consents to the Seller processing information about it, its directors, members, trustees, partners and sureties to conclude, administer, enforce and fund this Agreement, including sharing it with credit bureaux, insurers, funders and the Seller's agents, in accordance with the Protection of Personal Information Act 4 of 2013.

This Agreement may be signed in counterparts and by electronic signature.`,
  }
}

/** Clauses 7.8 to 7.13. */
export function instalmentSaleEnforcementClauses(data: DealDocumentData): WordingClause[] {
  return [breach(), charges(data), earlySettlement(), cession(), notices(data), general()]
}
