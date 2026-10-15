import CalculatorTabs from "./CalculatorTabs"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd, webApplicationLd } from "@/lib/seo/jsonld"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { toCrumbs } from "@/lib/nav/breadcrumbs"
import type { Metadata } from "next"
import { getT } from "@/lib/i18n/server"
import { calculatorsFaqs } from "./faqs"

export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: "Loan Calculators",
    description:
      "Assessment guidance for estimated repayments, affordability and product comparisons. Indicative only — subject to NCA affordability assessment.",
    path: "/site/calculators",
  })
}

const calculatorsTrail = [
  { name: "Home", path: "/" },
  { name: "Calculators", path: "/site/calculators" },
]

export default async function CalculatorsPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  const t = await getT("websiteCalculators")
  const faqs = calculatorsFaqs(t)
  const calculatorsSchema = [
    breadcrumbLd(calculatorsTrail),
    webApplicationLd({
      name: `${identity.tradingName} Loan Calculators`,
      description:
        "Interactive loan calculators for estimating instalments, checking affordability and comparing products. Results are indicative only.",
      path: "/site/calculators",
      applicationCategory: "FinanceApplication",
    }),
    faqLd(faqs),
  ]
  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <JsonLd id="calculators-schema" data={calculatorsSchema} />
      <section className="relative overflow-hidden px-4 py-20 text-center">
        <div className="absolute inset-0 bg-[#11141b]/50" />
        <div className="absolute inset-0 bg-linear-to-b from-[#11141b]/42 via-[#11141b]/28 to-[#11141b]" />
        <div className="relative">
          <Breadcrumbs items={toCrumbs(calculatorsTrail)} variant="onDark" className="mb-6 justify-center" />
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-[#a5b4fc]">{t("eyebrow")}</p>
          <h1 className="mb-3 text-balance text-4xl font-semibold text-white md:text-5xl">{t("title")}</h1>
          <p className="mx-auto max-w-lg text-sm leading-relaxed text-white/62">
            {t("intro")}
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-12">
        <CalculatorTabs />
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-4">
        <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">{t("howHeading")}</h2>
        <p className="mt-5 text-base leading-7 text-white/72">
          {t("howBody")}
        </p>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="border border-white/12 bg-white/[0.04] p-5">
            <h3 className="font-semibold text-white">{t("personalShortTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/64">
              {t("personalShortBody")}
            </p>
          </div>
          <div className="border border-white/12 bg-white/[0.04] p-5">
            <h3 className="font-semibold text-white">{t("businessTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/64">
              {t("businessBody")}
            </p>
          </div>
        </div>
        <h3 className="mt-10 text-xl font-semibold text-white">{t("tradeoffsHeading")}</h3>
        <p className="mt-3 text-base leading-7 text-white/72">
          {t("tradeoffsBody")}
        </p>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-12">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{t("faqEyebrow")}</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {t("faqHeading")}
        </h2>
        <div className="mt-8">
          <FaqAccordion items={faqs} />
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-12">
        <div className="border border-white/12 bg-white/[0.04] p-5 text-sm leading-relaxed text-white/58" style={{ borderLeft: "4px solid #4F46E5" }}>
          <p className="mb-1 font-semibold text-white">Important Disclosure</p>
          <p>
            All calculations are estimates for illustration purposes only. Final loan terms, interest rates, fees, and
            monthly instalments are subject to a full credit and affordability assessment. {identity.legalName} is a
            registered credit provider in terms of the National Credit Act (NCR Reg: {identity.ncrNumber}).
          </p>
        </div>
      </section>
    </main>
  )
}
