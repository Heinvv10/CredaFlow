/**
 * Homepage FAQ source. Used by both the visible FAQ section on the homepage
 * and the FAQPage JSON-LD emitted from app/page.tsx. Single source of truth
 * because Google penalises FAQPage schema that does not match what crawlers
 * see rendered — so both are built in the same locale.
 *
 * Kept short and high-level: site-wide entity-identification questions,
 * answered from the tenant's own identity and the products it offers.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { PublicLoanProduct } from "@/lib/public-loan-products"
import { localizeProduct } from "@/lib/i18n/products"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator } from "@/lib/i18n/translate"

export interface HomeFaq {
  question: string
  answer: string
}

type HomeFaqIdentity = Pick<LenderIdentity, "tradingName" | "legalName" | "ncrNumber" | "fspNumber" | "headOfficeCity">

export function homeFaqs(
  identity: HomeFaqIdentity,
  products: readonly PublicLoanProduct[],
  locale: Locale = DEFAULT_LOCALE,
): HomeFaq[] {
  const t = createTranslator(locale, "websiteHome")
  const tp = createTranslator(locale, "websiteProducts")
  const brand = identity.tradingName
  const offered = products.map((product) => localizeProduct(product, tp).label.toLowerCase())
  return [
    // The answer claims FSP authorisation, so it is asked only when the lender
    // holds an FSP number (a no-FSP variant would need every catalogue re-reviewed).
    ...(identity.fspNumber ? [{
      question: t("faqWhatQ", { brand }),
      answer: t("faqWhatA", { brand, legalName: identity.legalName, ncr: identity.ncrNumber, fsp: identity.fspNumber }),
    }] : []),
    {
      question: t("faqOfferQ", { brand }),
      answer:
        (offered.length > 0 ? t("faqOfferProducts", { brand, products: offered.join(", ") }) : t("faqOfferInsuranceOnly", { brand })) +
        t("faqOfferAffordability"),
    },
    {
      question: t("faqApplyQ", { brand }),
      answer: t("faqApplyA"),
    },
    {
      question: t("faqWhereQ", { brand }),
      answer:
        (identity.headOfficeCity
          ? t("faqWhereCity", { brand, city: identity.headOfficeCity })
          : t("faqWhereNoCity", { brand })) +
        t("faqWhereRegulation"),
    },
  ]
}
