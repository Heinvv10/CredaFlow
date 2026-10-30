import Link from "next/link"
import type { ReactNode } from "react"
import type { Metadata } from "next"
import {
  ArrowRight,
  Database,
  FileCheck2,
  Fingerprint,
  LockKeyhole,
  Mail,
  Scale,
  ShieldCheck,
  UserCheck,
} from "lucide-react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd } from "@/lib/seo/jsonld"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { toCrumbs } from "@/lib/nav/breadcrumbs"
import { getWebsiteIdentity } from "@/lib/website/identity"

// Legal copy: the wording is unchanged from the inherited
// policy; only the lender's identity values are substituted from its own
// LenderIdentity. Client legal must sign this page off before go-live.

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getWebsiteIdentity()
  return buildPageMetadata({
    identity,
    title: "Privacy Policy & POPIA Notice",
    description: identity
      ? `How ${identity.tradingName} collects, uses, stores and protects your personal information under POPIA. Includes your data subject rights and contact details.`
      : "",
    path: "/site/privacy",
  })
}

const privacyTrail = [
  { name: "Home", path: "/" },
  { name: "Privacy", path: "/site/privacy" },
]

const privacyBreadcrumb = breadcrumbLd(privacyTrail)

const collectedInfo = [
  {
    title: "Identity and contact",
    body: "Name, South African ID number, date of birth, phone number, email address and address details.",
    icon: Fingerprint,
  },
  {
    title: "Income and affordability",
    body: "Employment status, employer details, income, expenses, existing obligations and bank account information.",
    icon: Database,
  },
  {
    title: "Credit and application data",
    body: "Application details, product selection, credit bureau results, repayment behaviour and supporting documents.",
    icon: FileCheck2,
  },
  {
    title: "Digital interaction data",
    body: "Device, browser, IP address, form progress and website activity needed to secure and improve the service.",
    icon: LockKeyhole,
  },
]

const dataJourney = [
  "Capture consent and application details",
  "Verify identity and documentation",
  "Run affordability and credit checks",
  "Prepare disclosures and decision outcome",
  "Manage servicing, collections and regulatory records",
]

const uses = [
  "Assess loan, insurance and related financial-service requests",
  "Verify identity, reduce fraud risk and meet FICA, NCA and POPIA duties",
  "Calculate affordability, prepare disclosures and communicate application outcomes",
  "Administer accounts, repayments, claims, renewals and client support",
  "Report where required to regulators, credit bureaux and approved service partners",
  "Send relevant product information where the client has consented or where law allows it",
]

const rights = (brand: string) => [
  ["Access", `Ask what personal information ${brand} holds about you.`],
  ["Correction", "Request correction of inaccurate or incomplete information."],
  ["Objection", "Object to certain processing, including direct marketing."],
  ["Withdrawal", "Withdraw consent where processing depends on consent."],
  ["Deletion", "Request deletion where there is no lawful reason to retain the record."],
  ["Complaint", `Complain to ${brand} or the Information Regulator of South Africa.`],
]

const safeguards = [
  "Role-based access controls for staff and advisors",
  "Secure application and document workflows",
  "Audit trails for sensitive operational actions",
  "Retention aligned to credit, FICA and regulatory record obligations",
]

export default async function PrivacyPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  const brand = identity.tradingName
  return (
    <main className="min-h-screen bg-[#11141b] text-white">
      <JsonLd id="privacy-breadcrumb" data={privacyBreadcrumb} />
      <section className="relative overflow-hidden px-4 py-16 md:py-20">
        <div className="absolute inset-0 bg-[#11141b]/38" />
        <div className="absolute inset-0 bg-linear-to-r from-[#11141b] via-[#11141b]/76 to-[#11141b]/8" />
        <div className="relative mx-auto max-w-6xl">
          <Breadcrumbs items={toCrumbs(privacyTrail)} variant="onDark" className="mb-6" />
          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 border border-[#a5b4fc]/35 bg-[#a5b4fc]/10 px-3 py-2 text-xs font-bold uppercase tracking-[0.22em] text-[#a5b4fc]">
              <ShieldCheck size={16} />
              POPIA and client trust
            </div>
            <h1 className="text-balance text-4xl font-semibold tracking-tight text-white md:text-6xl">
              Privacy, consent and responsible data use.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-relaxed text-white/64 md:text-base">
              {brand} collects and processes personal information to assess applications, meet regulatory
              duties, protect clients and provide lending, insurance and related financial-service support.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/site/apply"
                className="inline-flex items-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-bold text-[#11141b] transition-colors hover:bg-[#c7d2fe]"
              >
                Continue application
                <ArrowRight size={16} />
              </Link>
              <a
                href={`mailto:${identity.publicEmail}`}
                className="inline-flex items-center gap-2 border border-white/16 px-5 py-3 text-sm font-bold text-white/78 transition-colors hover:bg-white/[0.05] hover:text-white"
              >
                <Mail size={16} />
                Contact privacy team
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-10 lg:grid-cols-[0.9fr_1.1fr]">
        <aside className="border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">Policy snapshot</p>
          <h2 className="mt-3 text-2xl font-semibold text-white">What this policy covers</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/58">
            This page explains how client information moves through the website, eligibility, application, portal and
            servicing workflows. It supports POPIA transparency, NCA affordability requirements and insurance
            disclosure readiness.
          </p>
          <div className="mt-6 space-y-3 text-sm">
            {[
              ["Responsible party", identity.legalName],
              ...(identity.ncrNumber ? [["NCR registration", identity.ncrNumber]] : []),
              ["Last reviewed", "May 2026"],
              ["Primary contact", identity.publicEmail],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between border border-white/8 bg-black/18 px-3 py-3">
                <span className="text-white/42">{label}</span>
                <span className="text-right font-semibold text-white/82">{value}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.28)] backdrop-blur-xl">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">Data workflow</p>
          <h2 className="mt-3 text-2xl font-semibold text-white">How information is used in the journey</h2>
          <div className="mt-6 space-y-3">
            {dataJourney.map((item, index) => (
              <div key={item} className="grid grid-cols-[auto_1fr] gap-4 border border-white/8 bg-black/16 p-4">
                <div className="flex h-9 w-9 items-center justify-center bg-[#a5b4fc] text-sm font-bold text-[#11141b]">
                  {index + 1}
                </div>
                <div>
                  <p className="font-semibold text-white">{item}</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/46">
                    Each stage should be visible to the client and supported by consent, disclosure or lawful basis.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {collectedInfo.map(({ title, body, icon: Icon }) => (
            <div key={title} className="border border-white/12 bg-white/[0.035] p-5">
              <Icon className="mb-5 text-[#a5b4fc]" size={26} />
              <h3 className="text-base font-semibold text-white">{title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-white/55">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-2">
        <PolicyPanel eyebrow="Processing purposes" title={`Why ${brand} uses this information`} icon={<UserCheck />}>
          <ul className="space-y-3">
            {uses.map((item) => (
              <li key={item} className="flex gap-3 text-sm leading-relaxed text-white/62">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 bg-[#a5b4fc]" />
                {item}
              </li>
            ))}
          </ul>
        </PolicyPanel>

        <PolicyPanel eyebrow="Sharing and safeguards" title="Who may receive information" icon={<LockKeyhole />}>
          <p className="text-sm leading-relaxed text-white/62">
            {brand} does not sell personal information. Information may be shared with credit bureaux, payment and
            banking partners, verification providers, insurers or underwriting partners, professional advisors,
            regulators and law-enforcement bodies where there is a lawful basis.
          </p>
          <div className="mt-5 grid gap-3">
            {safeguards.map((item) => (
              <div key={item} className="border border-white/8 bg-black/18 px-3 py-3 text-sm text-white/62">
                {item}
              </div>
            ))}
          </div>
        </PolicyPanel>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">Your POPIA rights</p>
              <h2 className="mt-3 text-2xl font-semibold text-white">Control, correction and complaints</h2>
            </div>
            <a
              href="https://inforegulator.org.za/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 border border-white/14 px-4 py-2 text-sm font-semibold text-white/72 hover:bg-white/[0.05] hover:text-white"
            >
              Information Regulator
              <ArrowRight size={15} />
            </a>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rights(brand).map(([right, body]) => (
              <div key={right} className="border border-white/8 bg-black/18 p-4">
                <p className="font-semibold text-white">{right}</p>
                <p className="mt-2 text-sm leading-relaxed text-white/52">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-14 pt-8">
        <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
          <PolicyPanel eyebrow="Retention" title="How long records are kept" icon={<Database />}>
            <p className="text-sm leading-relaxed text-white/62">
              {brand} retains information for as long as needed to provide services, resolve disputes, meet credit and
              insurance obligations and comply with applicable laws. Credit and FICA-related records are typically kept
              for at least five years after the relationship ends, unless a longer period is required.
            </p>
          </PolicyPanel>

          <div className="border border-[#a5b4fc]/35 bg-[#a5b4fc]/10 p-6">
            <Scale className="mb-4 text-[#a5b4fc]" size={28} />
            <h2 className="text-xl font-semibold text-white">Privacy contact</h2>
            <p className="mt-3 text-sm leading-relaxed text-white/60">
              To request access, correction, withdrawal of consent or to raise a privacy concern, contact {brand}.
            </p>
            <div className="mt-5 space-y-2 text-sm text-white/68">
              <p>
                <span className="text-white/42">Email:</span>{" "}
                <a href={`mailto:${identity.publicEmail}`} className="font-semibold text-[#a5b4fc] hover:underline">
                  {identity.publicEmail}
                </a>
              </p>
              <p>
                <span className="text-white/42">Phone:</span> {identity.publicPhone}
              </p>
              <p>
                <span className="text-white/42">Complaint escalation:</span> Information Regulator of South Africa
              </p>
              <p>
                <span className="text-white/42">POPIA complaints:</span>{" "}
                <a href="mailto:POPIAComplaints@inforegulator.org.za" className="font-semibold text-[#a5b4fc] hover:underline">
                  POPIAComplaints@inforegulator.org.za
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

function PolicyPanel({
  eyebrow,
  title,
  icon,
  children,
}: {
  eyebrow: string
  title: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <div className="border border-white/12 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.24)]">
      <div className="mb-5 flex h-12 w-12 items-center justify-center border border-[#a5b4fc]/35 bg-[#a5b4fc]/10 text-[#a5b4fc]">
        {icon}
      </div>
      <p className="text-xs font-bold uppercase tracking-[0.24em] text-[#a5b4fc]">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold text-white">{title}</h2>
      <div className="mt-5">{children}</div>
    </div>
  )
}
