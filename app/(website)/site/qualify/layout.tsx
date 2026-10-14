import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getT } from "@/lib/i18n/server"
import { qualifyFaqs } from "./faqs"

// The qualify page itself is a client component ("use client"), so metadata
// and JSON-LD are emitted from this server-component layout. The FAQPage
// schema uses the same qualifyFaqs list as the rendered page (see
// ./faqs.ts) so the structured data always matches what's visible to
// crawlers — Google penalises FAQPage markup that doesn't match the page.
export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: "Check If You Qualify",
    description:
      "Quick eligibility check for our loan products. No credit pull at this stage — formal applications are subject to full NCA affordability assessment.",
    path: "/site/qualify",
  })
}

export default async function QualifyLayout({ children }: { children: ReactNode }) {
  const identity = await getWebsiteIdentity()
  if (!identity) return <>{children}</>
  const qualifySchema = [
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Qualify", path: "/site/qualify" },
    ]),
    faqLd(qualifyFaqs(identity, await getT("websiteQualify"))),
  ]
  return (
    <>
      <JsonLd id="qualify-schema" data={qualifySchema} />
      {children}
    </>
  )
}
