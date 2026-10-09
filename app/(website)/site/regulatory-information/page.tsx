import Link from "next/link"
import { ArrowRight, BadgeCheck, Building2, FileText, Phone, ShieldCheck } from "lucide-react"
import { RegulatoryBand } from "@/components/website/RegulatoryBand"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { FaqAccordion } from "@/components/website/FaqAccordion"
import { toCrumbs } from "@/lib/nav/breadcrumbs"
import { formatIdentityDate, type LenderIdentity } from "@/lib/config/identity-schema"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { regulatoryFaqs } from "./faqs"
import { REGULATORY_BREADCRUMB } from "./breadcrumb"

// Legal copy (decision D-W2): the wording is unchanged from the inherited
// page; only the lender's identity values are substituted from its own
// LenderIdentity. The optional regulatory details (decision D-W5) are left off
// the page when the tenant has not set them, never filled with a default.
// Client legal must sign this page off before go-live.

// Per-row company-detail items, from the tenant's identity; an unset optional
// detail is omitted.
function companyDetails(identity: LenderIdentity): ReadonlyArray<readonly [string, string]> {
  const rows: [string, string | null][] = [
    ["Legal name", identity.legalName],
    ["Company registration number", identity.companyRegNumber],
    ["NCR registration number", identity.ncrNumber],
    ["NCR status", identity.ncrStatus],
    ["NCR final registration date", identity.ncrRegistrationDate && formatIdentityDate(identity.ncrRegistrationDate)],
    ["FSP number", identity.fspNumber],
    ["FSCA authorisation date", identity.fscaAuthorisationDate && formatIdentityDate(identity.fscaAuthorisationDate)],
    ["Country", "South Africa"],
  ]
  return rows.filter((row): row is [string, string] => row[1] !== null)
}

export default async function RegulatoryInformationPage() {
  const identity = await getWebsiteIdentity()
  if (!identity) return null
  return (
    <div className="bg-[#11141b] text-white">
      {/* organizationLd is emitted site-wide from app/(website)/layout.tsx —
          don't duplicate it here. The layout for this page adds
          breadcrumb + FAQPage on top. */}
      <RegulatoryBand identity={identity} />

      <section className="relative overflow-hidden px-4 py-20 sm:px-6 lg:px-8">
        <div className="relative mx-auto max-w-5xl">
          <Breadcrumbs
            items={toCrumbs(REGULATORY_BREADCRUMB)}
            variant="onDark"
            className="mb-6"
          />
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#a5b4fc]">
            Regulatory Information
          </p>
          <h1 className="mt-4 text-balance text-4xl font-semibold leading-tight tracking-normal text-white sm:text-5xl">
            {identity.tradingName} regulatory information.
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-white/72">
            {identity.legalName} is a South African private company operating in the
            financial services and credit sector. The company is registered
            with the National Credit Regulator as a credit provider and is
            listed by the Financial Sector Conduct Authority as an authorised
            financial services provider.
          </p>
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#1a1e27] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <Building2 className="h-6 w-6 text-[#a5b4fc]" aria-hidden="true" />
            <h2 className="text-3xl font-semibold tracking-tight text-white">
              {identity.tradingName} company details
            </h2>
          </div>
          <p className="mt-3 max-w-3xl text-base leading-7 text-white/64">
            Authoritative entity facts as recorded by the South African public
            registers. Identifiers below match the FSCA and NCR records.
          </p>
          <dl className="mt-8 grid gap-x-8 gap-y-4 border border-white/12 bg-white/[0.035] p-6 sm:grid-cols-2">
            {companyDetails(identity).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-xs font-semibold uppercase tracking-[0.18em] text-white/52">
                  {label}
                </dt>
                <dd className="text-base font-semibold text-white">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#11141b] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-2">
          <article>
            <div className="flex items-center gap-3">
              <BadgeCheck className="h-6 w-6 text-[#a5b4fc]" aria-hidden="true" />
              <h2 className="text-2xl font-semibold tracking-tight text-white">
                NCR registration
              </h2>
            </div>
            <p className="mt-4 text-base leading-7 text-white/68">
              {identity.legalName} is registered with the National Credit Regulator as
              a credit provider under registration number{" "}
              <strong className="text-white">{identity.ncrNumber}</strong>.
              {identity.ncrRegistrationDate && (
                <>
                  {" "}Final registration was confirmed on{" "}
                  <strong className="text-white">{formatIdentityDate(identity.ncrRegistrationDate)}</strong>.
                </>
              )}
            </p>
            <p className="mt-3 text-base leading-7 text-white/60">
              All credit applications are subject to affordability assessment
              under the National Credit Act. The NCR public register at{" "}
              <a
                href="https://www.ncr.org.za"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#a5b4fc] underline-offset-2 hover:underline"
              >
                ncr.org.za
              </a>{" "}
              is the authoritative source for this listing.
            </p>
          </article>
          <article>
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-6 w-6 text-[#a5b4fc]" aria-hidden="true" />
              <h2 className="text-2xl font-semibold tracking-tight text-white">
                FSCA authorisation
              </h2>
            </div>
            <p className="mt-4 text-base leading-7 text-white/68">
              {identity.legalName} is listed by the Financial Sector Conduct Authority
              as an authorised financial services provider under FSP number{" "}
              <strong className="text-white">{identity.fspNumber}</strong>.
              {identity.fscaAuthorisationDate && (
                <>
                  {" "}Authorisation was granted on{" "}
                  <strong className="text-white">{formatIdentityDate(identity.fscaAuthorisationDate)}</strong>.
                </>
              )}
            </p>
            <p className="mt-3 text-base leading-7 text-white/60">
              The FSCA FAIS register at{" "}
              <a
                href="https://www.fsca.co.za"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[#a5b4fc] underline-offset-2 hover:underline"
              >
                fsca.co.za
              </a>{" "}
              is the authoritative source for this listing.
            </p>
          </article>
        </div>
        <p className="mx-auto mt-10 max-w-5xl border border-white/8 bg-white/[0.025] p-5 text-sm leading-6 text-white/52">
          Public contact details and regulator-register addresses may differ.
          Customer-facing contact details are listed below and on the{" "}
          <Link href="/site/contact" className="text-[#a5b4fc] underline-offset-2 hover:underline">
            Contact page
          </Link>
          . Regulator-register information is shown above for transparency and
          verification.
        </p>
      </section>

      <section className="bg-[#1a1e27] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <Phone className="h-6 w-6 text-[#a5b4fc]" aria-hidden="true" />
            <h2 className="text-3xl font-semibold tracking-tight text-white">
              Public contact details
            </h2>
          </div>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            <ContactBlock
              label="Phone"
              value={identity.publicPhone}
              href={`tel:${identity.publicPhoneE164}`}
            />
            {identity.publicWhatsapp && identity.publicWhatsappE164 && (
              <ContactBlock
                label="WhatsApp"
                value={identity.publicWhatsapp}
                href={`https://wa.me/${identity.publicWhatsappE164.replace("+", "")}`}
              />
            )}
            <ContactBlock
              label="Email"
              value={identity.publicEmail}
              href={`mailto:${identity.publicEmail}`}
            />
            <ContactBlock label="Office" value={identity.registeredOfficeLines.join(", ")} />
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#11141b] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <FileText className="h-6 w-6 text-[#a5b4fc]" aria-hidden="true" />
            <h2 className="text-3xl font-semibold tracking-tight text-white">
              Frequently asked questions
            </h2>
          </div>
          <div className="mt-8">
            <FaqAccordion items={regulatoryFaqs(identity)} />
          </div>
          <div className="mt-10 border border-[#a5b4fc]/35 bg-[#a5b4fc]/10 p-6 text-center">
            <p className="text-sm text-white/68">
              Looking for product information instead?
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-3">
              <Link
                href="/"
                className="border border-white/16 px-5 py-3 text-sm font-semibold text-white/78 transition hover:text-white"
              >
                About {identity.tradingName}
              </Link>
              <Link
                href="/site/apply"
                className="inline-flex items-center gap-2 bg-[#a5b4fc] px-5 py-3 text-sm font-semibold text-[#11141b] transition hover:bg-[#c7d2fe]"
              >
                Apply online
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function ContactBlock({
  label,
  value,
  href,
}: {
  label: string
  value: string
  href?: string
}) {
  // External (non-tel:/mailto:) links get noopener/noreferrer + a new tab.
  // The WhatsApp wa.me deep-link is external; tel: and mailto: are
  // same-context handlers and should not open in a new tab.
  const isExternal = href ? /^https?:\/\//i.test(href) : false
  const valueEl = href ? (
    <a
      href={href}
      className="text-base font-semibold text-white transition hover:text-[#a5b4fc]"
      {...(isExternal
        ? { target: "_blank", rel: "noreferrer noopener" }
        : {})}
    >
      {value}
    </a>
  ) : (
    <p className="text-base font-semibold text-white">{value}</p>
  )
  return (
    <div className="border border-white/12 bg-white/[0.035] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/52">
        {label}
      </p>
      <div className="mt-2">{valueEl}</div>
    </div>
  )
}
