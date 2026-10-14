/**
 * Shared FAQ source data for /site/contact.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered FAQ items always match the FAQPage JSON-LD schema.
 * Google penalises FAQPage markup that doesn't match what's visible on the
 * page, so this single-source-of-truth pattern is load-bearing. Both pass a
 * translator for the same request locale (useT on the page, getT in the
 * layout), so the two stay in one language too.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { Translator } from "@/lib/i18n/translate"

export interface ContactFaq {
  question: string
  answer: string
}

export function contactFaqs(
  identity: Pick<LenderIdentity, "tradingName" | "registeredOfficeLines" | "publicWhatsapp">,
  t: Translator<"websiteContact">,
): readonly ContactFaq[] {
  const brand = identity.tradingName
  return [
    { question: t("faqRespondQ", { brand }), answer: t("faqRespondA") },
    // Hours are Monday–Friday only.
    // Keep in sync with the visible hours block in ./page.tsx.
    { question: t("faqHoursQ"), answer: t("faqHoursA") },
    { question: t("faqMethodQ"), answer: identity.publicWhatsapp ? t("faqMethodAWhatsapp") : t("faqMethodAPhone") },
    { question: t("faqComplaintQ"), answer: t("faqComplaintA") },
    { question: t("faqApplyQ"), answer: t("faqApplyA") },
    { question: t("faqWhereQ", { brand }), answer: t("faqWhereA", { address: identity.registeredOfficeLines.join(", ") }) },
  ]
}
