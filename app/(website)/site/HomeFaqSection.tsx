import { FaqAccordion } from "@/components/website/FaqAccordion"
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales"
import { createTranslator } from "@/lib/i18n/translate"
import type { HomeFaq } from "./home-faqs"

// Visible mirror of the FAQPage JSON-LD emitted from app/page.tsx. Both
// surfaces use the same homeFaqs() list so the rendered Q&A and the structured
// data can't drift apart — Google penalises FAQPage markup that doesn't match
// what crawlers can see rendered on the page.
export function HomeFaqSection({ brand, faqs, locale = DEFAULT_LOCALE }: { brand: string; faqs: readonly HomeFaq[]; locale?: Locale }) {
  const t = createTranslator(locale, "websiteHome")
  return (
    <section className="border-t border-white/10 bg-[#11141b] px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
          {t("faqEyebrow")}
        </p>
        <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-normal text-white sm:text-4xl">
          {t("faqHeading", { brand })}
        </h2>
        <p className="mt-4 text-base leading-7 text-white/64">
          {t("faqIntro", { brand })}
        </p>

        <div className="mt-10">
          <FaqAccordion items={faqs} />
        </div>
      </div>
    </section>
  )
}
