import { describe, expect, it } from "vitest"
import { publicLoanProducts } from "@/lib/public-loan-products"
import { createTranslator } from "./translate"
import { localizeProduct, termText } from "./products"

describe("localizeProduct", () => {
  // The English catalogue repeats lib/public-loan-products.ts' copy; this keeps the two from drifting.
  it.each(publicLoanProducts.map((p) => [p.code, p] as const))("English %s is the catalogue product unchanged", (_code, product) => {
    expect(localizeProduct(product, createTranslator("en", "websiteProducts"))).toEqual(product)
  })

  it("translates words only: figures, pricing and links are the product's own", () => {
    const product = publicLoanProducts.find((p) => p.code === "personal")!
    const af = localizeProduct(product, createTranslator("af", "websiteProducts"))
    expect(af.label).toBe("Persoonlike lening")
    expect(af.desktopCta).toBe("Doen aansoek vir ’n persoonlike lening")
    const words = ["label", "shortLabel", "description", "amountLabel", "modelLabel", "primaryMetricLabel", "secondaryMetricLabel", "tertiaryMetricLabel", "desktopCta", "mobileCta", "note"]
    const strip = (p: object) => Object.fromEntries(Object.entries(p).filter(([k]) => !words.includes(k)))
    expect(strip(af)).toEqual(strip(product))
  })
})

describe("termText", () => {
  it("singularises at 1 and follows the product's unit", () => {
    const t = createTranslator("en", "websiteProducts")
    expect(termText(t, { termUnit: "months" }, 1)).toBe("1 month")
    expect(termText(t, { termUnit: "months" }, 12)).toBe("12 months")
    expect(termText(t, { termUnit: "days" }, 30)).toBe("30 days")
    expect(termText(createTranslator("zu", "websiteProducts"), { termUnit: "months" }, 3)).toBe("Izinyanga ezingu-3")
  })
})
