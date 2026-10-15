import type { Translator } from "@/lib/i18n/translate"

/** The calculators FAQ, shown on the page and emitted as its FAQPage JSON-LD, in one locale. */
export function calculatorsFaqs(t: Translator<"websiteCalculators">) {
  return [
    { question: t("faq1Q"), answer: t("faq1A") },
    { question: t("faq2Q"), answer: t("faq2A") },
    { question: t("faq3Q"), answer: t("faq3A") },
    { question: t("faq4Q"), answer: t("faq4A") },
    { question: t("faq5Q"), answer: t("faq5A") },
    { question: t("faq6Q"), answer: t("faq6A") },
  ]
}
