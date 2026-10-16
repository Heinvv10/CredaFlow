import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getT } from "@/lib/i18n/server"
import { applyFaqs } from "./faqs"

// The apply page itself is a client component ("use client"), so metadata and
// JSON-LD are emitted from this server-component layout. The FAQPage schema
// uses the same applyFaqs source as the rendered "Application FAQ" section
// (see ./faqs.ts), in the same locale, so the structured data always matches
// what crawlers see — Google penalises FAQPage markup that doesn't match the page.
export async function generateMetadata(): Promise<Metadata> {
  const identity = await getWebsiteIdentity()
  return buildPageMetadata({
    identity,
    title: "Apply Online",
    // No FSP number, no FAIS claim (Fair Score audit goal §2a.2).
    description:
      `Apply online for our loan products. NCR-registered, ${identity?.fspNumber ? "FAIS-authorised, " : ""}POPIA-aware. Requires SA ID, payslip and proof of bank account.`,
    path: "/site/apply",
  })
}

export default async function ApplyLayout({ children }: { children: ReactNode }) {
  const applySchema = [
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Apply", path: "/site/apply" },
    ]),
    faqLd(applyFaqs(await getT("websiteApply"))),
  ]
  return (
    <>
      <JsonLd id="apply-schema" data={applySchema} />
      {children}
    </>
  )
}
