import Link from "next/link"
import type { Metadata } from "next"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"
import { termsCoverInsurance, termsIntro, termsNotice, termsSections } from "./sections"

export async function generateMetadata(): Promise<Metadata> {
  const [identity, site] = await Promise.all([getWebsiteIdentity(), getSiteJurisdiction()])
  return buildPageMetadata({
    identity,
    title: "Terms & Conditions",
    description: !identity
      ? ""
      : site.nca
        ? `The terms that apply to using the ${identity.tradingName} website and to any credit, insurance enquiry or capital service. The full binding terms of a loan are set out in your signed credit agreement.`
        : `The terms that apply to using the ${identity.tradingName} website and to any credit or capital service. The full binding terms of a loan are set out in your signed loan agreement.`,
    path: "/site/terms",
  })
}

// NOTE: this page gives the footer "Terms & Conditions" link a real
// destination that summarises the terms framework and points to the binding
// documents. It intentionally does NOT restate the binding, NCA-mandated loan
// terms — those live in the pre-agreement statement and credit agreement the
// client receives and signs. The notice
// keeps the website terms binding, points each product's binding
// terms to the right signed document (credit agreement / insurer policy), and
// states signed docs take precedence; a governing-law + updates section (8)
// is included. Legal should still confirm the wording. A consolidated, legally-approved public
// T&C can still replace/extend the body below when the legal team produces it.
export default async function TermsPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  const site = await getSiteJurisdiction()
  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <section className="border-b border-white/10 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">Legal</p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-white md:text-5xl">Terms &amp; Conditions</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/62">
            {termsIntro(identity, site)}
          </p>
        </div>
      </section>

      <section className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="border border-[#a5b4fc]/30 bg-[#a5b4fc]/8 p-4 text-sm leading-relaxed text-white/70">
            <strong className="text-white">Please note:</strong> {termsNotice(site)}
          </div>
        </div>
      </section>

      <section className="px-4 pb-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl space-y-10">
          {/* The insurance section only for a lender that holds an FSP number;
              the rest keep their order, numbered afresh. */}
          {termsSections(identity, site)
            .filter((section) => termsCoverInsurance(identity, site) || !section.heading.endsWith("Insurance enquiries"))
            .map((section, index) => ({ ...section, heading: section.heading.replace(/^\d+\. /, `${index + 1}. `) }))
            .map((section) => (
            <div key={section.heading}>
              <h2 className="text-xl font-semibold text-white">{section.heading}</h2>
              {section.body.map((paragraph, i) => (
                <p key={i} className="mt-3 text-sm leading-7 text-white/62">
                  {paragraph}
                </p>
              ))}
              {section.links && (
                <div className="mt-3 flex flex-wrap gap-4">
                  {section.links.map((link) => (
                    <Link key={link.href} href={link.href} className="text-sm font-semibold text-[#a5b4fc] hover:underline">
                      {link.label} →
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
