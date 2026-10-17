// Clauses 7 to 11 of the NCA asset agreement (see ./nca-agreement.ts).
// DRAFT for the lender's legal team; docs/asset-finance/legal-wording/nca.md.
import type { NcaAssetDocumentData } from "../nca/types"
import type { NcaClause } from "./nca-agreement"

export function ncaAgreementRightsClauses(data: NcaAssetDocumentData): NcaClause[] {
  return [
    {
      heading: "Voluntary surrender",
      text: [
        "7.1 The Consumer may terminate this agreement at any time by giving the Credit Provider written notice under section 127(1) of the Act, in writing or through the client portal. If the Goods are in the Consumer's possession, the Consumer must return them to the Credit Provider's place of business during ordinary business hours within 5 business days after the notice, or at another time and place the Credit Provider agrees to in writing; if they are not, the Consumer must tell the Credit Provider where they are.",
        "7.2 Within 10 business days after the later of receiving the notice and receiving the Goods, the Credit Provider will give the Consumer written notice of the estimated value of the Goods, as section 127(2) of the Act requires.",
        "7.3 Within 10 business days after receiving that notice, the Consumer may unconditionally withdraw the termination notice and resume possession of the Goods, unless the Consumer is in default under this agreement, as section 127(3) of the Act provides.",
        "7.4 If the Consumer does not withdraw the notice, the Credit Provider must sell the Goods as soon as practicable for the best price reasonably obtainable, credit or debit the Consumer's account with the proceeds less the reasonable costs of the sale, and give the Consumer written notice of the settlement value immediately before the sale, the gross and net proceeds and the amount credited or debited, as section 127(4) and (5) of the Act require.",
        "7.5 If the proceeds credited exceed the settlement value, the Credit Provider will pay the difference to the Consumer. If they are less, the Credit Provider may demand payment of the balance in that notice; if the Consumer does not pay it within 10 business days after receiving the demand, the Credit Provider may begin legal proceedings for it. Sections 127(6) to (9) and 128 of the Act apply, including the Consumer's right to apply to the National Consumer Tribunal to review the sale.",
      ].join("\n\n"),
    },
    {
      heading: "Cooling-off right",
      text: [
        "8.1 If this agreement was signed at a place other than the Credit Provider's registered business premises, the Consumer may rescind it without giving a reason, by delivering written notice to the Credit Provider within 5 business days after the date on which the Consumer signed it, as section 121 of the Act provides.",
        "8.2 On rescission each party must return what it received under this agreement within the time and in the manner section 121(3) of the Act requires. The Credit Provider will not charge any penalty or fee for the rescission beyond what section 121 of the Act permits.",
      ].join("\n\n"),
    },
    {
      heading: "Credit information, debt review and complaints",
      text: [
        "9.1 The Credit Provider will report information about this agreement and the Consumer's payment record to registered credit bureaux as the Act and the Regulations require. Before it reports adverse information, it will give the Consumer at least 20 business days' written notice, as the Regulations require.",
        "9.2 If the Consumer is or expects to become over-indebted, the Consumer may apply to a registered debt counsellor for debt review under section 86 of the Act.",
        "9.3 The Consumer may lodge a complaint about this agreement with the Credit Provider at the address in clause 10. If the complaint is not resolved, the Consumer may refer it to an alternative dispute resolution agent, a consumer court or an ombud with jurisdiction, to the National Credit Regulator, or to the National Consumer Tribunal, as Chapter 7 of the Act provides.",
        "9.4 The Credit Provider processes the Consumer's personal information under the Protection of Personal Information Act 4 of 2013 to assess, conclude, administer and enforce this agreement and as the law requires. The Consumer may ask to see and correct that information as that Act provides.",
      ].join("\n\n"),
    },
    {
      heading: "Addresses and notices",
      text: [
        `10.1 For section 96 of the Act, the Consumer's address for notices and documents under this agreement is ${data.borrower.addressLines.join(", ") || "the address the Consumer gives the Credit Provider in writing"}, and the Credit Provider's address is its registered office, ${data.lender.registeredOfficeLines.join(", ")}. Either party may change its address by written notice to the other.`,
        "10.2 The Credit Provider will deliver documents to the Consumer by the method the Consumer chose under section 65 of the Act, except where the Act requires a particular method, as section 129 of the Act does for the notice in clause 6.2.",
        "10.3 A notice under this agreement must be in writing. A notice the Consumer gives through the client portal or by email to the address the Credit Provider publishes for notices is in writing.",
      ].join("\n\n"),
    },
    {
      heading: "General",
      text: [
        "11.1 This agreement, the Quotation and the Repayment Schedule are the whole agreement between the parties about the Goods and the credit. The Credit Provider has delivered, or will deliver, a copy of this agreement to the Consumer free of charge, as section 93(2) of the Act requires.",
        "11.2 This agreement may be changed only in writing signed by both parties, or as the Act permits, such as a change in a variable interest rate under clause 3.3.",
        "11.3 Nothing in this agreement waives or limits any right the Act gives the Consumer or does anything section 90 of the Act prohibits. A provision that would do so is void to that extent, and the rest of this agreement remains in force.",
        "11.4 This agreement is governed by the law of the Republic of South Africa. Proceedings under it will be brought in a court that has jurisdiction under the Act and the law; nothing in this agreement is a consent by the Consumer to the jurisdiction of any other court.",
        "11.5 A relaxation or indulgence the Credit Provider allows the Consumer does not waive or limit the Credit Provider's rights under this agreement.",
        "11.6 The Consumer may ask for this agreement in another official language the Consumer reads or understands, as section 63 of the Act provides.",
        "11.7 The Credit Provider may cede its rights under this agreement and will tell the Consumer of the cession in writing; a cession does not affect any right or defence the Consumer has under this agreement or the Act. The Consumer may not cede the Consumer's rights or delegate the Consumer's obligations without the Credit Provider's prior written consent.",
      ].join("\n\n"),
    },
  ]
}
