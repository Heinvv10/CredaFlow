import { defineChangeHandlers } from "../define"

export default defineChangeHandlers([
  { kind: "PRODUCT_VERSION", module: "@/lib/product-engine/change-handlers", export: "productVersionHandler" },
  { kind: "PRODUCT_PRICING_RULE", module: "@/lib/product-engine/change-handlers", export: "pricingRuleHandler" },
] as const)
