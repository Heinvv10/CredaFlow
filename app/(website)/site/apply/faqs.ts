/**
 * Shared FAQ source data for /site/apply.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered "Application FAQ" items always match the FAQPage
 * JSON-LD schema. Google penalises FAQPage markup that doesn't match what's
 * visible on the page, so this single-source-of-truth pattern is load-bearing.
 * Both pass a translator for the same request locale.
 */
import type { Translator } from "@/lib/i18n/translate"

export interface ApplyFaq {
  question: string
  answer: string
}

export function applyFaqs(t: Translator<"websiteApply">): readonly ApplyFaq[] {
  return [
    { question: t("faqDocsQ"), answer: t("faqDocsA") },
    { question: t("faqTimeQ"), answer: t("faqTimeA") },
    { question: t("faqSafeQ"), answer: t("faqSafeA") },
    { question: t("faqAfterQ"), answer: t("faqAfterA") },
  ]
}
