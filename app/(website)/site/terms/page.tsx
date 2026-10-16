import Link from "next/link"
import type { Metadata } from "next"
import { buildPageMetadata } from "@/lib/seo/metadata"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import { getWebsiteIdentity } from "@/lib/website/identity"

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getWebsiteIdentity()
  return buildPageMetadata({
    identity,
    title: "Terms & Conditions",
    description: identity
      ? `The terms that apply to using the ${identity.tradingName} website and to any credit, insurance enquiry or capital service. The full binding terms of a loan are set out in your signed credit agreement.`
      : "",
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
//
// White-label: the wording is unchanged; only the lender's
// identity values are substituted from its own LenderIdentity. Section 3's
// pricing link points at the calculators, because the pricing page is gone.

const sections = (identity: Pick<LenderIdentity, "tradingName" | "legalName" | "ncrNumber" | "fspNumber">) => [
  {
    heading: "1. Using this website",
    body: [
      `This website provides information about ${identity.tradingName}'s credit, insurance-enquiry and capital services, and tools such as loan calculators and an eligibility check. The figures shown by the calculators and eligibility check are indicative estimates only — they are not an offer of credit and do not guarantee approval or final pricing.`,
      "You agree to use this website lawfully and not to misuse the application, contact or portal forms (for example by submitting another person's information without their consent).",
    ],
  },
  {
    heading: "2. Credit and lending",
    body: [
      "All credit is provided subject to a full affordability assessment and credit check as required by the National Credit Act (NCA) No. 34 of 2005. Approval, the amount advanced, the term and the final cost of credit are confirmed only after that assessment.",
      "The full, binding terms and conditions of any loan — including the interest rate, fees, repayment schedule and your rights — are set out in your pre-agreement statement and credit agreement, which you receive and sign before any money is disbursed. Those signed documents govern your loan.",
    ],
  },
  {
    heading: "3. Fees and cost of credit",
    body: [
      "Initiation fees, service fees and interest are disclosed to you in the pre-agreement statement before you sign, in line with the NCA and the National Credit Regulations. Indicative pricing is summarised on our pricing page.",
    ],
    links: [{ label: "See pricing", href: "/site/calculators" }],
  },
  {
    heading: "4. Insurance enquiries",
    body: [
      `Insurance is offered on an enquiry basis. ${identity.tradingName} acts as an authorised intermediary (FSP ${identity.fspNumber}); policies are issued and underwritten by the relevant insurer under that insurer's own terms, subject to an advisor suitability review.`,
    ],
  },
  {
    heading: "5. Privacy and your information",
    body: [
      "We process your personal information in line with the Protection of Personal Information Act (POPIA). How we collect, use, store and protect your information — and your rights — are set out in our Privacy & POPIA notice.",
    ],
    links: [{ label: "Read the Privacy & POPIA notice", href: "/site/privacy" }],
  },
  {
    heading: "6. Complaints",
    body: [
      "If something goes wrong, we want to put it right. Lodge a complaint with us first, through our contact page. If we do not resolve it, you can take a credit complaint to the Credit Ombud or the National Credit Regulator, which can refer a matter to the National Consumer Tribunal; complaints about an insurance policy or claim go to the National Financial Ombud, and complaints about the advice or service of a financial intermediary to the FAIS Ombud.",
    ],
    links: [{ label: "Lodge a complaint", href: "/site/contact#complaints" }],
  },
  {
    heading: "7. Regulatory status",
    body: [
      `${identity.legalName} is a registered credit provider (NCR Reg ${identity.ncrNumber}) and an authorised financial services provider (FSP ${identity.fspNumber}). Full regulatory details are available on our regulatory information page.`,
    ],
    links: [{ label: "Regulatory information", href: "/site/regulatory-information" }],
  },
  {
    heading: "8. Governing law and changes to these terms",
    body: [
      `These terms, and your use of the ${identity.tradingName} website, are governed by the laws of the Republic of South Africa, and the South African courts have jurisdiction. Any credit or insurance product remains subject to the laws that apply to it, including the National Credit Act and the Financial Advisory and Intermediary Services Act.`,
      "We may update these terms from time to time; the version published on this page is the current one. Last updated: 5 July 2026.",
    ],
  },
]

export default async function TermsPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <section className="border-b border-white/10 px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">Legal</p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-white md:text-5xl">Terms &amp; Conditions</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/62">
            These terms apply to your use of the {identity.tradingName} website and to any credit, insurance enquiry or capital
            service you request. The full, binding terms of a loan are set out in the credit agreement you sign.
          </p>
        </div>
      </section>

      <section className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="border border-[#a5b4fc]/30 bg-[#a5b4fc]/8 p-4 text-sm leading-relaxed text-white/70">
            <strong className="text-white">Please note:</strong> these terms govern your use of this website. The full,
            binding terms of a specific product are set out in the documents you receive and sign — your pre-agreement
            statement and credit agreement for a loan, or the insurer&apos;s policy documents for insurance — and those signed
            documents take precedence over the summaries on this page.
          </div>
        </div>
      </section>

      <section className="px-4 pb-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl space-y-10">
          {sections(identity).map((section) => (
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
