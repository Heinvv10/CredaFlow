import { FaqAccordion } from "@/components/website/FaqAccordion"
import type { HomeFaq } from "./home-faqs"

// Visible mirror of the FAQPage JSON-LD emitted from app/page.tsx. Both
// surfaces use the same homeFaqs() list so the rendered Q&A and the structured
// data can't drift apart — Google penalises FAQPage markup that doesn't match
// what crawlers can see rendered on the page.
export function HomeFaqSection({ brand, faqs }: { brand: string; faqs: readonly HomeFaq[] }) {
  return (
    <section className="border-t border-white/10 bg-[#11141b] px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
          Frequently asked questions
        </p>
        <h2 className="mt-4 text-3xl font-semibold leading-tight tracking-normal text-white sm:text-4xl">
          About {brand}.
        </h2>
        <p className="mt-4 text-base leading-7 text-white/64">
          Short answers to the questions clients ask most often about {brand}.
        </p>

        <div className="mt-10">
          <FaqAccordion items={faqs} />
        </div>
      </div>
    </section>
  )
}
