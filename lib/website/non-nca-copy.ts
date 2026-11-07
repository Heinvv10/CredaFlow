/**
 * Public-site answers whose catalogue text cites the NCA, POPIA, the NCR or the FAIS
 * Ombud. A lender outside the NCA gets these instead: English literals, because the
 * catalogue cannot change without resetting every language's native-speaker review
 * (lib/i18n/.claude.md), and no statute or regulator is named, since none has been
 * confirmed for the lender's country.
 */
export const NON_NCA_SITE_COPY = {
  contactIntro: "Ask about applications, documents, repayments or client portal support.",
  contactComplaintAnswer: (country: string) =>
    `Use the form above and mark your enquiry as a complaint: we acknowledge it and give you a reference number. If we have not resolved it, you may take it to the regulator or ombud that applies to your credit product in ${country}.`,
  contactApplyAnswer:
    "No. Applications go through the eligibility check and online application path so we can capture your consent and run the required affordability assessment.",
  qualifyDescription:
    "Quick eligibility check for our loan products. No credit pull at this stage — formal applications are subject to a full affordability assessment.",
  qualifyGuaranteeAnswer:
    "No. A positive eligibility result indicates that the basic criteria are met. Approval is still subject to a full affordability assessment, document verification and disclosure of the loan terms.",
  qualifyWhoAnswer:
    "Salaried employees, self-employed applicants, pensioners and grant recipients with regular, verifiable income are considered. Every application is assessed individually against affordability rules.",
  qualifyAfterAnswer:
    "If the indicative result looks positive, you can continue to a full application. You will submit supporting documents and consent to the affordability and credit checks before any offer is made.",
  calculatorsPlanAnswer:
    "No. The results are indicative estimates to help you plan. They are not an offer, a quote or a credit agreement. Your final amount, rate, term and fees are set during a full affordability assessment.",
  calculatorsAffordabilityAnswer:
    "It compares the income and expenses you enter to give an indicative view of what you may be able to repay. A formal application still applies a full affordability assessment, including income and expense verification.",
  calculatorsFeesQuestion: "Are fees included in the estimate?",
  calculatorsFeesAnswer:
    "The calculators show core interest and instalment estimates. Product fees and charges are disclosed in the key facts statement before you commit.",
} as const
