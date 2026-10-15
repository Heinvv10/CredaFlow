/**
 * Shared FAQ source data for /site/qualify.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered FAQ items always match the FAQPage JSON-LD schema.
 * Google penalises FAQPage markup that doesn't match what's visible on the
 * page, so this single-source-of-truth pattern is load-bearing. Both pass a
 * translator for the same request locale.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { Translator } from "@/lib/i18n/translate"

export type QualifyFaqGroup = "how" | "result"

export interface QualifyFaq {
  group: QualifyFaqGroup
  question: string
  answer: string
}

// Render order for the grouped FAQ sections on /site/qualify, with their headings.
export const QUALIFY_FAQ_GROUPS: readonly { group: QualifyFaqGroup; heading: "groupHow" | "groupResult" }[] = [
  { group: "how", heading: "groupHow" },
  { group: "result", heading: "groupResult" },
] as const

export function qualifyFaqs(identity: Pick<LenderIdentity, "tradingName">, t: Translator<"websiteQualify">): readonly QualifyFaq[] {
  return [
    { group: "how", question: t("faqCreditCheckQ"), answer: t("faqCreditCheckA") },
    { group: "how", question: t("faqScoreQ"), answer: t("faqScoreA") },
    { group: "how", question: t("faqInfoQ"), answer: t("faqInfoA") },
    { group: "result", question: t("faqGuaranteeQ"), answer: t("faqGuaranteeA") },
    { group: "result", question: t("faqWhoQ", { brand: identity.tradingName }), answer: t("faqWhoA") },
    { group: "result", question: t("faqAfterQ"), answer: t("faqAfterA") },
  ]
}
