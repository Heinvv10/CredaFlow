import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getT } from "@/lib/i18n/server"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"
import { applyFaqs } from "./faqs"

// The apply page itself is a client component ("use client"), so metadata and
// JSON-LD are emitted from this server-component layout. The FAQPage schema
// uses the same applyFaqs source as the rendered "Application FAQ" section
// (see ./faqs.ts), in the same locale, so the structured data always matches
// what crawlers see — Google penalises FAQPage markup that doesn't match the page.
export async function generateMetadata(): Promise<Metadata> {
  const [identity, site] = await Promise.all([getWebsiteIdentity(), getSiteJurisdiction()])
  return buildPageMetadata({
    identity,
    title: "Apply Online",
    // No FSP number, no FAIS claim (Fair Score audit goal §2a.2).
    description: site.nca
      ? `Apply online for our loan products. NCR-registered, ${identity?.fspNumber ? "FAIS-authorised, " : ""}POPIA-aware. Requires SA ID, payslip and proof of bank account.`
      : "Apply online for our loan products. Requires your national ID, payslip and proof of bank account.",
    path: "/site/apply",
  })
}

export default async function ApplyLayout({ children }: { children: ReactNode }) {
  // The catalogue's apply FAQ speaks of SA IDs, POPIA and the NCA: a lender outside the NCA shows none, in markup or schema.
  const { nca } = await getSiteJurisdiction()
  const applySchema = [
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Apply", path: "/site/apply" },
    ]),
    ...(nca ? [faqLd(applyFaqs(await getT("websiteApply")))] : []),
  ]
  return (
    <>
      <JsonLd id="apply-schema" data={applySchema} />
      {children}
    </>
  )
}
