import { defineAuditActions } from "../define"

export default defineAuditActions({
  // A product version approved (maker-checker) and written (lib/product-engine/change-handlers.ts).
  PRODUCT_VERSION_CREATED: "PRODUCT_VERSION_CREATED",
  // A version that came into effect and made LoanProduct equal to it (lib/product-engine/activate.ts).
  PRODUCT_VERSION_ACTIVATED: "PRODUCT_VERSION_ACTIVATED",
  // A pricing rule approved and written, and one approved and retired.
  PRODUCT_PRICING_RULE_CREATED: "PRODUCT_PRICING_RULE_CREATED",
  PRODUCT_PRICING_RULE_RETIRED: "PRODUCT_PRICING_RULE_RETIRED",
  // Staff set the segment / channel / campaign an application is priced on.
  APPLICATION_PRICING_INPUT_SET: "APPLICATION_PRICING_INPUT_SET",
  // The terms a loan was written on were recorded with the loan.
  LOAN_TERMS_RECORDED: "LOAN_TERMS_RECORDED",
})
