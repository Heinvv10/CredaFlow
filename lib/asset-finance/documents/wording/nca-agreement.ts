// Clause wording for the NCA instalment sale / finance lease agreement
// (../nca/agreement-pdf.ts), clauses 1 to 6; clauses 7 to 11 are in
// ./nca-agreement-rights.ts. DRAFT for the lender's legal team (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17): the document
// keeps its watermark until TenantConfig.assetFinanceLegalWordingApproved.
// Code gaps: docs/asset-finance/legal-wording/README.md.
// Sources, drafting choices and open points: docs/asset-finance/legal-wording/nca.md.
// Every party, figure, rate and date comes from the document data.
import { formatZarPdf } from "@/lib/pdf/helpers"
import { RATE_BASIS_LABELS } from "../../deal-labels"
import { NCA_LARGE_AGREEMENT_THRESHOLD_CENTS } from "../../nca-thresholds"
import { rateDescription } from "../document-parts"
import { formatIsoDatePdf } from "../pdf-layout"
import type { NcaAssetDocumentData } from "../nca/types"
import { ncaAgreementRightsClauses } from "./nca-agreement-rights"

export interface NcaClause {
  heading: string
  text: string
}

// GN R713 of 1 June 2006: a credit transaction below R15 000 is a small
// agreement; at or above R250 000 (NCA_LARGE_AGREEMENT_THRESHOLD_CENTS) large.
const NCA_SMALL_AGREEMENT_THRESHOLD_CENTS = 1_500_000

export type NcaAgreementSize = "small" | "intermediate" | "large"

/** The section 9 size of a credit transaction from its principal debt. */
export function ncaAgreementSize(principalCents: number): NcaAgreementSize {
  if (principalCents >= NCA_LARGE_AGREEMENT_THRESHOLD_CENTS) return "large"
  return principalCents < NCA_SMALL_AGREEMENT_THRESHOLD_CENTS ? "small" : "intermediate"
}

/** "a large agreement", "an intermediate agreement", "a small agreement". */
export const ncaAgreementSizePhrase = (principalCents: number): string => {
  const size = ncaAgreementSize(principalCents)
  return `${size === "intermediate" ? "an" : "a"} ${size} agreement`
}

/** "an instalment agreement" or "a lease", the Act's section 1 names for the two contract types. */
export const ncaAgreementKind = (data: Pick<NcaAssetDocumentData, "contractType">): string =>
  data.contractType === "FINANCE_LEASE" ? "a lease" : "an instalment agreement"

/** The rate sentence shared by the agreement (clause 3.3) and the quotation. */
export function ncaRateTerms(p: NcaAssetDocumentData["pricing"], lastDueDate: string): string {
  const rate = `Interest is charged on the outstanding principal debt at ${rateDescription(p)}. It accrues daily on the reducing balance, on the actual number of days over a 365-day year, and is payable with each instalment.`
  if (p.rateBasis === "FIXED") return `${rate} The rate is fixed for the whole term of this agreement.`
  const label = RATE_BASIS_LABELS[p.rateBasis]
  return `${rate} The rate is variable: it is linked to ${label}, and when ${label} changes the rate changes by the same amount from the date the change takes effect. The Credit Provider then recalculates the instalment so that the agreement still ends on ${formatIsoDatePdf(lastDueDate)} and the residual amount does not change, and gives the Consumer written notice of the new rate and instalment as section 104 of the Act requires. The rate will never exceed the maximum prescribed under section 105 of the Act for this type of agreement: a change that would take it above that maximum is not applied.`
}

export function ncaAgreementClauses(data: NcaAssetDocumentData): NcaClause[] {
  return [...coreClauses(data), ...ncaAgreementRightsClauses(data)]
}

function coreClauses(data: NcaAssetDocumentData): NcaClause[] {
  const p = data.pricing
  const lease = data.contractType === "FINANCE_LEASE"
  const first = data.schedule[0]
  const last = data.schedule[data.schedule.length - 1]
  if (!first || !last) throw new RangeError("The agreement needs a repayment schedule")
  const size = ncaAgreementSize(p.principalCents)
  const residual = p.balloonCents > 0
    ? ` The last instalment includes the residual (balloon) amount of ${formatZarPdf(p.balloonCents)}.`
    : ""
  return [
    {
      heading: "Interpretation",
      text: [
        `1.1 In this agreement "the Act" means the National Credit Act 34 of 2005 and "the Regulations" means the National Credit Regulations made under it; "the Credit Provider" means ${data.lender.legalName}, registered credit provider ${data.lender.ncrNumber}; "the Consumer" means ${data.borrower.name}; "the Goods" means the ${data.asset.description}, serial or VIN number ${data.asset.serialNumber}, with its parts and accessories and anything fitted to it in replacement; "the Quotation" means the pre-agreement statement and quotation the Credit Provider gave the Consumer for this agreement under section 92 of the Act; "the Repayment Schedule" means the schedule of instalments that accompanies the Quotation and this agreement; and "business day" is counted as section 2(5) of the Act provides.`,
        `1.2 This agreement is ${ncaAgreementKind(data)} as defined in section 1 of the Act and ${ncaAgreementSizePhrase(p.principalCents)} under section 9 of the Act. If any provision of this agreement conflicts with the Act or the Regulations, the Act and the Regulations prevail.`,
      ].join("\n\n"),
    },
    {
      heading: "Delivery, possession, risk and ownership",
      text: [
        `2.1 The Credit Provider ${lease ? "lets" : "sells"} the Goods to the Consumer on the terms of this agreement. The Consumer takes possession of the Goods when they are delivered and signs a delivery note when it receives them.`,
        lease
          ? "2.2 The Goods remain the property of the Credit Provider during the lease. Ownership passes to the Consumer when the Consumer has paid every amount due under this agreement, including the residual amount, without any further payment or document being required of the Consumer."
          : "2.2 Ownership of the Goods remains with the Credit Provider until the Consumer has paid every amount due under this agreement, including any residual amount. Ownership then passes to the Consumer without any further payment or document being required of the Consumer.",
        "2.3 Risk of loss of, damage to or destruction of the Goods passes to the Consumer on delivery. Loss or damage does not end the Consumer's obligations under this agreement; insurance proceeds are dealt with as clause 4.4 provides.",
        "2.4 Until ownership passes, the Consumer must: (a) keep the Goods in the Consumer's possession and under the Consumer's control in the Republic of South Africa; (b) use them with reasonable care, for their intended purpose and in accordance with the law and the manufacturer's instructions; (c) keep them in good repair and working order at the Consumer's own cost, fair wear and tear excepted; (d) not sell, let, lend, pledge or otherwise encumber or dispose of the Goods, or part with possession of them, without the Credit Provider's prior written consent; (e) not remove or alter any serial number, VIN or other identifying mark; (f) tell the Credit Provider in writing within 5 business days of any change in the place where the Goods are normally kept and of any loss of, damage to, theft or attachment of, or third-party claim to, the Goods; and (g) make the Goods available for inspection at a reasonable time and place arranged with the Consumer in advance.",
        "2.5 If the Goods must be registered under the National Road Traffic Act 93 of 1996, the Credit Provider is recorded as titleholder and the Consumer as owner, and the Consumer must keep them licensed and roadworthy at the Consumer's own cost.",
        "2.6 Nothing in this agreement entitles the Credit Provider, or anyone acting for it, to enter the Consumer's premises or to take possession of the Goods without the Consumer's consent given at the time or an order of court.",
      ].join("\n\n"),
    },
    {
      heading: "Payments, interest and statutory charges",
      text: [
        `3.1 The Consumer must pay ${data.schedule.length} monthly instalments in the amounts and on the dates in the Repayment Schedule, the first on ${formatIsoDatePdf(first.dueDate)} and the last on ${formatIsoDatePdf(last.dueDate)}. The base instalment is ${formatZarPdf(p.instalmentCents)}.${residual} Each instalment includes interest, the monthly service fee${p.creditLifePremiumCents > 0 ? " and the credit-life premium" : ""}.`,
        `3.2 Payments are made in full on their due dates, by debit order or electronic transfer into the account the Credit Provider designates in writing, quoting reference ${data.reference}.`,
        `3.3 ${ncaRateTerms(p, last.dueDate)}`,
        `3.4 The Consumer must pay an initiation fee of ${formatZarPdf(p.initiationFeeCents)}, included in the amounts in the Repayment Schedule, and a monthly service fee of ${formatZarPdf(p.monthlyServiceFeeCents)}. Neither exceeds the maximum prescribed under section 105 of the Act. The Credit Provider will not charge any fee, charge or other amount that section 101 of the Act does not permit or that section 100 of the Act prohibits.`,
        "3.5 If an amount is not paid when due, interest continues to run on the overdue principal at the rate in clause 3.3, and not at a higher rate, from the day after the due date until it is paid. The Credit Provider may also charge the default administration charges and collection costs that section 101(1)(f) and (g) of the Act and the Regulations permit. Under section 103(5) of the Act, the interest, fees and charges that accrue while the Consumer is in default will together not exceed the unpaid balance of the principal debt when the default occurred.",
        "3.6 Each payment is applied in the order section 126(3) of the Act requires: first to interest due, then to fees and charges due, and then to the principal debt.",
        "3.7 The cash price of the Goods includes value-added tax. The Credit Provider will issue the tax invoice the Value-Added Tax Act 89 of 1991 requires for the supply of the Goods.",
      ].join("\n\n"),
    },
    {
      heading: "Insurance and credit-life election",
      text: [
        "4.1 From delivery until ownership passes, the Consumer must keep the Goods comprehensively insured against loss, theft and damage for not more than their replacement value, with the Credit Provider's interest noted on the policy. The Consumer may choose the insurer and the policy: as section 106 of the Act provides, the Credit Provider may not require the Consumer to insure with a particular insurer. The Consumer must give the Credit Provider proof of cover when asked.",
        "4.2 If the Consumer does not maintain that insurance, the Credit Provider may, after giving the Consumer written notice and 10 business days to provide proof of cover, arrange cover for not more than the replacement value of the Goods, as section 106 of the Act permits, and the Consumer must pay the premium. The Credit Provider will tell the Consumer the insurer, the cover and the premium in writing.",
        p.creditLifePremiumCents > 0
          ? `4.3 The Consumer has elected credit-life cover at a premium of ${formatZarPdf(p.creditLifePremiumCents)} a month, included in each instalment and in the cost of credit. The cover will not exceed the outstanding balance of the Consumer's obligations under this agreement. The Consumer may at any time replace it with a policy of the Consumer's own choice that provides at least the minimum benefits the Credit Life Insurance Regulations, 2017 require, by giving the Credit Provider the details of the new policy; the premium in this agreement then stops.`
          : "4.3 No credit-life premium is payable under this agreement.",
        "4.4 Insurance proceeds paid for loss of or damage to the Goods are paid to the Credit Provider to the extent of the amount owing under this agreement, and are applied to repair or replace the Goods or to reduce the amount owing, as the Consumer and the Credit Provider agree. Any balance is paid to the Consumer.",
      ].join("\n\n"),
    },
    {
      heading: "Consumer statements and early settlement",
      text: [
        "5.1 The Credit Provider will deliver a statement of account to the Consumer at least once every three months, as section 108 of the Act requires, by the method of delivery the Consumer chose under section 65 of the Act. The Consumer may also ask for a statement at any time, and current statements are available in the client portal.",
        `5.2 The Consumer may settle this agreement at any time, with or without advance notice, by paying the settlement amount under section 125 of the Act: the unpaid balance of the principal debt, including any residual amount, and the unpaid interest, fees and charges payable up to the settlement date.${size === "large" ? " Because this is a large agreement, the Credit Provider may also charge an early-termination charge, which will not exceed what section 125(3) of the Act permits (no more than three months' interest)." : " No early-termination charge is payable."}`,
        "5.3 On request, the Credit Provider will give the Consumer a written settlement quotation. When the settlement amount is paid, this agreement ends and ownership of the Goods passes to the Consumer as clause 2.2 provides.",
      ].join("\n\n"),
    },
    {
      heading: "Default, enforcement and statutory notices",
      text: [
        "6.1 The Consumer is in default if any amount payable under this agreement is not paid in full on its due date.",
        "6.2 If the Consumer is in default, the Credit Provider will not begin legal proceedings to enforce this agreement before (a) it has delivered to the Consumer the notice that section 129(1)(a) of the Act requires, in the manner section 129 requires; and (b) the periods and other requirements of section 130 of the Act have been met, including that the Consumer has been in default for at least 20 business days and at least 10 business days have passed since that notice was delivered. The content of that notice is prescribed by the Act and is not repeated here.",
        "6.3 The Credit Provider may terminate this agreement before the end of its term only as section 123 of the Act allows: when the Consumer is in default and the Credit Provider has followed the procedure in sections 129 and 130 of the Act.",
        "6.4 If a court orders the attachment of the Goods, the Credit Provider will deal with them as section 131 of the Act provides: it will value them, give the Consumer notice of their estimated value, sell them for the best price reasonably obtainable and account to the Consumer for the proceeds, as sections 127(2) to (9) and 128 of the Act require.",
        "6.5 At any time before the Credit Provider has cancelled this agreement, the Consumer may remedy a default by paying all overdue amounts, together with the default charges the Act permits and the reasonable costs of enforcing the agreement up to the time the default is remedied, as section 129(3) of the Act provides. Section 129(4) of the Act sets out when this right is no longer available, including after the Goods have been sold under an attachment order or after a surrender under clause 7. When the default is remedied the Consumer may resume possession of Goods the Credit Provider has taken back.",
        "6.6 The Credit Provider may recover the costs of collection and enforcement only to the extent section 101(1)(g) of the Act, the Regulations and any order of court permit.",
        "6.7 If the Consumer applies for debt review under section 86 of the Act, the Credit Provider may enforce this agreement only as sections 86 and 88 of the Act allow.",
      ].join("\n\n"),
    },
  ]
}
