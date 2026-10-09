import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { REGULATORY_BREADCRUMB } from "./breadcrumb"
import { regulatoryFaqs } from "./faqs"

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getWebsiteIdentity()
  return buildPageMetadata({
    identity,
    title: "Regulatory Information — NCR & FSCA Details",
    description: identity
      ? `${identity.legalName} regulatory information. NCR registration ${identity.ncrNumber}, ` +
        `FSP number ${identity.fspNumber}, company registration ${identity.companyRegNumber} and public contact details.`
      : "",
    path: "/site/regulatory-information",
  })
}

export default async function RegulatoryInformationLayout({
  children,
}: {
  children: ReactNode
}) {
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
