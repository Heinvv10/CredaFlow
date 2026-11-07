import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { ncaOnlyPage } from "@/lib/jurisdiction/nca-only"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"
import { REGULATORY_BREADCRUMB } from "./breadcrumb"
import { regulatoryFaqs } from "./faqs"

export async function generateMetadata(): Promise<Metadata> {
  const [identity, site] = await Promise.all([getWebsiteIdentity(), getSiteJurisdiction()])
  if (!site.nca) return {}
  return buildPageMetadata({
    identity,
    title: identity?.fspNumber ? "Regulatory Information — NCR & FSCA Details" : "Regulatory Information — NCR Details",
    description: identity
      ? `${identity.legalName} regulatory information. ${identity.ncrNumber ? `NCR registration ${identity.ncrNumber}, ` : ""}` +
        (identity.fspNumber ? `FSP number ${identity.fspNumber}, ` : "") +
        `company registration ${identity.companyRegNumber} and public contact details.`
      : "",
    path: "/site/regulatory-information",
  })
}

export default async function RegulatoryInformationLayout({
  children,
}: {
  children: ReactNode
}) {
  // Gated here as well as in the page: this layout would otherwise print the NCR breadcrumb and FAQ schema around a 404.
  await ncaOnlyPage()
  const identity = await getWebsiteIdentity()
  return (
    <>
      {identity && (
        <JsonLd id="regulatory-schema" data={[breadcrumbLd(REGULATORY_BREADCRUMB), faqLd(regulatoryFaqs(identity))]} />
      )}
      {children}
    </>
  )
}
