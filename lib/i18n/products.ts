import { formatRatePct, type PublicLoanProduct, type PublicLoanProductCode } from "@/lib/public-loan-products"
import type { MessageKey, Translator } from "./translate"

type ProductsT = Translator<"websiteProducts">
type Prefix = "shortTerm" | "personal" | "po" | "invoice"

const PREFIX: Record<PublicLoanProductCode, Prefix> = {
  "short-term": "shortTerm",
  personal: "personal",
  "purchase-order": "po",
  "invoice-discounting": "invoice",
}

const key = (p: Prefix, field: string) => `${p}_${field}` as MessageKey<"websiteProducts">

/**
 * A public loan product with its display copy in the reader's language. Only
 * the words change: amounts, terms, pricing and links are the product's own.
 * English yields exactly the catalogue's strings.
 */
export function localizeProduct(product: PublicLoanProduct, t: ProductsT): PublicLoanProduct {
  const p = PREFIX[product.code]
  const cta = t(key(p, "cta"))
  return {
    ...product,
    label: t(key(p, "label")),
    shortLabel: t(key(p, "shortLabel")),
    description: t(key(p, "description")),
    amountLabel: t(key(p, "amountLabel")),
    modelLabel: t(key(p, "modelLabel")),
    primaryMetricLabel: t(key(p, "primaryMetricLabel")),
    secondaryMetricLabel: t(key(p, "secondaryMetricLabel")),
    tertiaryMetricLabel: t("term"),
    desktopCta: cta,
    mobileCta: cta,
    note: t(key(p, "note")),
  }
}

/**
 * A term in the product's unit: "1 month", "12 months", "30 days". Singular at
 * 1 — PO funding's 1-month minimum makes it reachable with a slider drag.
 */
export function termText(t: ProductsT, product: Pick<PublicLoanProduct, "termUnit">, term: number): string {
  if (product.termUnit === "days") return term === 1 ? t("oneDay") : t("days", { n: term })
  return term === 1 ? t("oneMonth") : t("months", { n: term })
}

/** formatInterestLabel, translated: "5%/mo flat", "2.8%/mo reducing". */
export function interestText(t: ProductsT, product: Pick<PublicLoanProduct, "interestRatePm" | "interestModel">): string {
  const model = `model_${product.interestModel}` as MessageKey<"websiteProducts">
  return `${formatRatePct(product.interestRatePm)}${t("perMonth")} ${t(model)}`.trim()
}

/** The bare unit word for a range ("3-60 months"). */
export function termUnitText(t: ProductsT, product: Pick<PublicLoanProduct, "termUnit">): string {
  return t(product.termUnit === "days" ? "unitDays" : "unitMonths")
}
