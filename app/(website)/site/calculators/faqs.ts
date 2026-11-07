import type { Translator } from "@/lib/i18n/translate"
import { NON_NCA_SITE_COPY } from "@/lib/website/non-nca-copy"
import { ZA_SITE, type SiteJurisdiction } from "@/lib/website/site-jurisdiction"

/** The calculators FAQ, shown on the page and emitted as its FAQPage JSON-LD, in one locale. */
export function calculatorsFaqs(t: Translator<"websiteCalculators">, site: SiteJurisdiction = ZA_SITE) {
  return [
    { question: t("faq1Q"), answer: site.nca ? t("faq1A") : NON_NCA_SITE_COPY.calculatorsPlanAnswer },
    { question: t("faq2Q"), answer: t("faq2A") },
    { question: t("faq3Q"), answer: t("faq3A") },
    { question: t("faq4Q"), answer: site.nca ? t("faq4A") : NON_NCA_SITE_COPY.calculatorsAffordabilityAnswer },
    { question: t("faq5Q"), answer: t("faq5A") },
    site.nca
      ? { question: t("faq6Q"), answer: t("faq6A") }
      : { question: NON_NCA_SITE_COPY.calculatorsFeesQuestion, answer: NON_NCA_SITE_COPY.calculatorsFeesAnswer },
  ]
}
