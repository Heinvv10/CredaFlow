// Clause wording for the NCA pre-agreement statement and quotation
// (../nca/quote-pdf.ts). DRAFT for the lender's legal team; sources and open
// points: docs/asset-finance/legal-wording/nca.md.
import { formatZarPdf } from "@/lib/pdf/helpers"
import type { NcaAssetDocumentData } from "../nca/types"
import { ncaAgreementKind, ncaAgreementSizePhrase, ncaRateTerms, type NcaClause } from "./nca-agreement"

export function ncaQuoteClauses(data: NcaAssetDocumentData): NcaClause[] {
  const p = data.pricing
  const last = data.schedule[data.schedule.length - 1]
  if (!last) throw new RangeError("The quotation needs a repayment schedule")
  return [{
    heading: "Statutory disclosures and validity period",
    text: [
      `1.1 In this quotation "the Act" means the National Credit Act 34 of 2005, "the Credit Provider" means ${data.lender.legalName}, registered credit provider ${data.lender.ncrNumber}, and "the Consumer" means ${data.borrower.name}. This is the pre-agreement statement and quotation that section 92 of the Act requires before the Credit Provider may enter into ${ncaAgreementKind(data)} with the Consumer. On these figures the proposed agreement would be ${ncaAgreementSizePhrase(p.principalCents)} under section 9 of the Act.`,
      "1.2 This quotation is not a credit agreement. It does not bind the Consumer, and signing the acknowledgement below records only that the Consumer received it. A credit agreement comes into existence only when both parties sign the agreement itself.",
      `1.3 The Credit Provider is bound by this quotation for five business days after the date on which it is delivered to the Consumer, as section 92 of the Act provides.${p.rateBasis === "FIXED" ? "" : " Because the proposed rate is variable, a change in the reference rate before the agreement is signed changes the rate, the instalments and the total cost of credit by the corresponding amount; any other change needs a new quotation."}`,
      `1.4 ${ncaRateTerms(p, last.dueDate)}`,
      `1.5 The total cost of credit of ${formatZarPdf(p.totalCostOfCreditCents)} is the interest, the initiation fee, the monthly service fees and any credit-life premiums shown above, and the total repayable is ${formatZarPdf(p.totalRepayableCents)}. No other fee or charge is payable, except the default charges and collection costs that section 101 of the Act permits if the Consumer does not pay on time. The interest rate, the initiation fee and the monthly service fee do not exceed the maxima prescribed under section 105 of the Act.`,
      [
        "1.6 The proposed agreement will require the Consumer to keep the asset described above comprehensively insured until ownership passes. The Consumer may choose the insurer and the policy; under section 106 of the Act the Credit Provider may not require the Consumer to use a particular insurer.",
        p.creditLifePremiumCents > 0
          ? ` The Consumer has elected credit-life cover at ${formatZarPdf(p.creditLifePremiumCents)} a month, which is included in the instalments and the cost of credit. The Consumer may instead provide, or later substitute, a policy of the Consumer's own choice that meets the minimum benefits of the Credit Life Insurance Regulations, 2017.`
          : " No credit-life premium is included in these figures.",
      ].join(""),
      "1.7 Under the Act the Consumer will have the right to: settle the agreement early under section 125; terminate it and surrender the goods under section 127; receive the notice required by section 129 before any legal proceedings to enforce it; rescind it within 5 business days if it is signed at a place other than the Credit Provider's registered business premises, under section 121; receive statements of account under section 108; and apply for debt review under section 86. The proposed agreement sets out these rights in full.",
    ].join("\n\n"),
  }]
}
