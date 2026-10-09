import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { APPLY_FAQS } from "./faqs"

// The apply page itself is a client component ("use client"), so metadata and
// JSON-LD are emitted from this server-component layout. The FAQPage schema
// uses the same APPLY_FAQS source as the rendered "Application FAQ" section
// (see ./faqs.ts) so the structured data always matches what crawlers see —
// Google penalises FAQPage markup that doesn't match the page.
export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: "Apply Online",
    description:
      "Apply online for our loan products. NCR-registered, FAIS-authorised, POPIA-aware. Requires SA ID, payslip and proof of bank account.",
    path: "/site/apply",
  })
}

const applySchema = [
  breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "Apply", path: "/site/apply" },
  ]),
  faqLd(APPLY_FAQS),
]

export default function ApplyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <JsonLd id="apply-schema" data={applySchema} />
      {children}
    </>
  )
}
