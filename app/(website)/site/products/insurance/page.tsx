import { Shield, HeartHandshake, ClipboardCheck } from "lucide-react"
import type { Metadata } from "next"
import ProductPageTemplate, { type ProductPageProps } from "@/components/website/ProductPageTemplate"
import { ProductDetailSections } from "@/components/website/ProductDetailSections"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd, financialServiceLd } from "@/lib/seo/jsonld"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { InsuranceEnquiryForm } from "@/components/website/InsuranceEnquiryForm"
import Link from "next/link"
import { headers } from "next/headers"
import {
  isQuickQuoteEmbeddingHost,
  resolveQuickQuoteEmbedOrigin,
} from "@/lib/insurance/quickquote-config"
import { toCrumbs } from "@/lib/nav/breadcrumbs"
import { insuranceFaqs } from "./faqs"

/** The comparison surface now has its own page — see that file for why. */
const QUOTES_PATH = "/site/products/insurance/quotes"

export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: "Credit-Life & Funeral Insurance Enquiries",
    description:
      "FAIS-authorised insurance enquiry pathways — funeral, credit-life and short-term insurance options for South Africans.",
    path: "/site/products/insurance",
  })
}

const insuranceTrail = [
  { name: "Home", path: "/" },
  { name: "Insurance", path: "/site/products/insurance" },
]

function coverContent(identity: LenderIdentity): ProductPageProps {
  return {
    hero: {
      eyebrow: "Insurance · enquiry pathways",
      headline: "Insurance for what matters most, guided by professional advice.",
      subhead:
        "FAIS-authorised guidance on funeral, credit-life and related insurance. We assess your needs and route your enquiry to a suitable underwriter.",
    },
    welcome: {
      title: "Insurance enquiries",
      subtitle: "We assess suitability and route your enquiry; the underwriter issues the cover.",
      body: `At ${identity.tradingName}, we help you explore insurance that protects what matters most. We discuss your options, run a suitability assessment under the FAIS framework, and route your enquiry to a suitable underwriter. The insurance itself is provided by the underwriter under its own product terms.`,
    },
    services: {
      sectionTitle: "Insurance enquiry pathways",
      sectionIntro:
        "We are a FAIS-authorised intermediary. We help you enquire about insurance, assess suitability, and connect you with an underwriter who issues and prices the policy.",
      groups: [
        {
          title: "Insurance for your loan",
          icon: Shield,
          items: [
            "Credit-life insurance enquiries",
            "Insurance linked to a new or existing loan",
            "Costs and exclusions disclosed before you decide",
          ],
        },
        {
          title: "Insurance for your family",
          icon: HeartHandshake,
          items: [
            "Funeral insurance pathways",
            "Insurance to help with final expenses",
            "Plain-language explanation of what is and isn't covered",
          ],
        },
        {
          title: "How an enquiry works",
          icon: ClipboardCheck,
          items: [
            "Advisor suitability assessment under FAIS",
            "Insurance provided by underwriters, on their terms",
            "No obligation at the enquiry stage",
          ],
        },
      ],
    },
    whyChoose: {
      title: `Why choose ${identity.tradingName} for insurance`,
      bullets: [
        "FAIS-authorised intermediary — we route enquiries, underwriters issue the cover",
        "Suitability assessment under the FAIS General Code of Conduct",
        "Costs, waiting periods and exclusions explained before you decide",
        "No obligation at the enquiry stage",
        "Complaints follow the FAIS route, with referral to the FAIS Ombud",
        `Authorised Financial Services Provider (FSP ${identity.fspNumber})`,
      ],
    },
    mission: {
      title: "Our commitment",
      body: "As a FAIS-authorised intermediary, we match your needs to a suitable underwriter and set out the costs, waiting periods and exclusions up front — the decision, and the policy, stay with you and the insurer.",
    },
    ctas: {
      primary: { label: "Enquire about insurance", href: "/site/contact" },
      secondary: { label: "Speak to an adviser", href: "/site/contact" },
    },
  }
}

/**
 * Rendered per request rather than prerendered, because the QuickQuote section
 * is gated on runtime environment. `next build` runs inside the Docker image
 * build with no access to the box's .env, so a static page would bake the
 * "unconfigured" state and setting the variables later would silently do
 * nothing. Remove this only if the gate stops depending on runtime env.
 */
export const dynamic = "force-dynamic"

export default async function CoverProductPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  const coverFaqs = insuranceFaqs(identity)
  const content = coverContent(identity)

  // Null unless the embed is fully configured AND flagged on, so the page
  // renders exactly as it does today in every environment without credentials.
  //
  // Also gated on the request host. `/site/*` is classified neither staff-only
  // nor client-only, so this page is reachable on app.* and portal.* as well
  // as the marketing origins — and those hosts are not in `frame-ancestors`.
  // Rendering the panel there offered a button whose frame CSP then refused in
  // silence. Both sides now derive from FSP_QUICKQUOTE_FRAME_ANCESTORS
  // (lib/insurance/quickquote-config.ts).
  const requestHeaders = await headers()
  const hostname = (requestHeaders.get("host") ?? "")
    .split(":")[0]
    .toLowerCase()
    .replace(/\.$/, "")

  const quickQuoteOrigin = isQuickQuoteEmbeddingHost(hostname)
    ? resolveQuickQuoteEmbedOrigin()
    : null

  return (
    <>
      <JsonLd
        id="product-cover"
        data={[
          breadcrumbLd(insuranceTrail),
          financialServiceLd({
            name: `${identity.tradingName} — Credit-Life and Funeral Insurance Enquiries`,
            description: `Short-term insurance and credit-life insurance enquiry pathways from FAIS-authorised ${identity.tradingName}. Funeral, life and credit-life insurance paths for South Africans.`,
            path: "/site/products/insurance",
            serviceType: "insurance enquiry pathways",
          }),
          faqLd(coverFaqs),
        ]}
      />
      {/*
        When the comparison surface is live it becomes the hero's PRIMARY
        action. Measured on staging before this change: the quote CTA sat
        3136px down a 6332px page — 50%, 2.7 screens — behind two explainer
        sections, so the only instant, self-service action on the page was the
        hardest thing on it to reach. The section itself cannot simply be moved
        up: the explainers live inside ProductPageTemplate, which every product
        page shares. Overriding the hero CTA puts the quote one click from the
        top without restructuring a shared component.

        Falls back to the enquiry CTAs when the flag is off, so the page is
        never advertising a surface that will not render.
      */}
      <ProductPageTemplate
        {...content}
        ctas={
          quickQuoteOrigin
            ? {
                primary: { label: "Get instant quotes", href: QUOTES_PATH },
                secondary: { label: "Rather speak to an adviser", href: "#insurance-enquiry" },
              }
            : content.ctas
        }
        breadcrumb={toCrumbs(insuranceTrail)}
      />
      {/* ⚠️ FAIS COPY — NOT YET APPROVED BY LEGAL.
          The rest of this page describes an advice-led pathway ("suitability
          assessment", "routes your enquiry to a suitable advisor"). QuickQuote
          is the opposite: execution-only, no advice, no needs analysis. Two
          different financial services with two different FAIS bases sitting on
          one page reads as contradictory positioning unless the distinction is
          explicit, which is what the framing below is for. Legal must sign off
          on this wording and on whether the surrounding advice-led copy needs
          amending, before the flag is switched on. */}
      {quickQuoteOrigin && (
      <section
        id="insurance-quote"
        className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:py-20"
      >
          {/* scroll-mt-20 because the site header is `sticky top-0` and 65px
              tall. Without it an anchor jump aligns the section top with
              viewport y=0 — directly UNDERNEATH the header — so the "option
              one" eyebrow renders behind it and, with this section's own 64px
              of top padding, the visitor arrives looking at ~145px of
              apparently empty page. On a 390px phone that reads as a broken
              link, which is exactly how it was reported. Measured: sectionTop
              was -105px after the jump. */}
          {/* max-w-6xl, wider than the prose sections around it: this one holds
              the quote embed, a working surface of five insurer rows with logos
              and prices, not a column of text. At max-w-3xl the iframe rendered
              733px wide on a 2445px viewport and read as a widget bolted onto
              the page rather than part of it. */}
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">
            Two ways to insure · option one
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Compare quotes yourself, right now
          </h2>
          <p className="mt-4 text-base leading-7 text-white/72">
            Compare vehicle, home contents and buildings cover from our panel of insurers in
            a few minutes and decide for yourself.{" "}
            <strong className="font-semibold text-white/88">
              This is a quote-only service: no advice is given, and no assessment of your
              needs, objectives or circumstances is carried out.
            </strong>{" "}
            If you would rather be guided, use option two below.
          </p>
          <div className="mt-8">
            {/* Links out rather than embedding. The frame now lives on its own
                page: every defect this surface produced came from being an
                iframe inside a longer page — it could only grow and never
                shrink, accumulated ~1190px of dead space, oscillated when its
                height was transitioned, landed behind the sticky header on an
                anchor jump, and lost the visitor's answers on a tab switch. */}
            <Link
              href={QUOTES_PATH}
              className="inline-flex items-center gap-2 bg-[#a5b4fc] px-6 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
            >
              Compare car insurance quotes
            </Link>
          </div>
          <p className="mx-auto mt-5 max-w-lg text-xs leading-5 text-white/48">
            The quote service is operated by FSP Solutions. It sends the details you enter
            directly to them, and lets them set their own cookies. If you choose a quote and
            ask to be contacted, an adviser from {identity.tradingName} will call you about it. No advice is
            provided — see the important information on the form.
          </p>
        </section>
      )}
      <section id="insurance-enquiry" className="mx-auto max-w-3xl scroll-mt-20 px-4 py-16 sm:py-20">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">
          {quickQuoteOrigin ? "Two ways to insure · option two" : "Start an enquiry"}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          {quickQuoteOrigin ? "Or have an adviser guide you" : "Tell us what you need insured"}
        </h2>
        <p className="mt-4 text-base leading-7 text-white/72">
          Leave your details and an adviser from {identity.tradingName} will call you back to discuss short-term insurance options.
          {quickQuoteOrigin
            ? " This pathway includes a suitability assessment under the FAIS framework, which the instant-quote option above does not."
            : ""}{" "}
          There is no obligation at the enquiry stage.
        </p>
        <div className="mt-8">
          <InsuranceEnquiryForm />
        </div>
      </section>
      <ProductDetailSections
        goodFitItems={[
          "You want funeral or credit-life cover guidance",
          "You need help understanding options, premiums and exclusions",
          "You prefer an advisor-led enquiry before committing",
        ]}
        notIdealItems={[
          "You need emergency medical care or claims assistance",
          "You want to buy cover without suitability guidance",
          "You are not ready to compare premiums, exclusions and waiting periods",
        ]}
        fitItems={[
          "Clients wanting credit-life cover linked to lending",
          "Families considering funeral insurance pathways",
          "Individuals or businesses needing an advisor-led insurance enquiry",
        ]}
        processItems={[
          "Start an enquiry",
          "Advisor discusses needs and suitability",
          "Underwriter terms are explained before any policy decision",
        ]}
        documentItems={[
          "South African ID or business details",
          "Contact and beneficiary information where relevant",
          "Existing loan or policy details if the enquiry is linked to cover",
        ]}
        decisionItems={[
          "Confirm who is insured and what is excluded",
          "Check premiums, waiting periods and claim rules",
          "Remember the underwriter issues the policy on its own terms",
        ]}
        lenderName={identity.tradingName}
        note={`Insurance is an advisor-led enquiry pathway. ${identity.tradingName} helps with suitability and routing; the policy is issued and priced by the relevant underwriter.`}
        enquiryHref="/site/contact?enquiry=insurance"
        enquiryLabel="Start insurance enquiry"
      />
      <section className="mx-auto max-w-4xl px-4 py-16 sm:py-20">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">
          Insurance FAQ
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white md:text-4xl">
          About {identity.tradingName} insurance enquiries
        </h2>
        <p className="mt-6 text-base leading-7 text-white/72">
          {identity.tradingName} is a FAIS-authorised intermediary (FSP {identity.fspNumber}) for short-term and credit-life insurance enquiries. Insurance itself is provided by underwriters under their own product terms; {identity.tradingName}&apos;s role is to discuss options, run a suitability assessment and route enquiries to the right advisor.
        </p>
        <div className="mt-10">
          <FaqAccordion items={coverFaqs} />
        </div>
      </section>
    </>
  )
}
