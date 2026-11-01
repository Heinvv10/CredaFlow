import { defineChangeHandlers } from "../define"

export default defineChangeHandlers([
  { kind: "PRODUCT_VERSION", module: "@/lib/product-engine/change-handlers", export: "productVersionHandler" },
  { kind: "PRODUCT_PRICING_RULE", module: "@/lib/product-engine/change-handlers", export: "pricingRuleHandler" },
  { kind: "LOAN_PRODUCT", module: "@/lib/product-config/change-handler", export: "loanProductHandler" },
] as const)
