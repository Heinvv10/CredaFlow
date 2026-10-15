import type { Metadata } from "next"
import type { ReactNode } from "react"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { JsonLd } from "@/components/seo/JsonLd"
import { breadcrumbLd, contactPageLd, faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getT } from "@/lib/i18n/server"
import { contactFaqs } from "./faqs"

// The contact page itself is a client component ("use client"), so metadata
// and JSON-LD are emitted from this server-component layout.
export async function generateMetadata(): Promise<Metadata> {
  return buildPageMetadata({
    identity: await getWebsiteIdentity(),
    title: "Contact Us & Complaints",
    description:
      "Contact us for product enquiries or to lodge a complaint. Office details, email, complaints process and regulatory escalation routes.",
    path: "/site/contact",
  })
}

export default async function ContactLayout({ children }: { children: ReactNode }) {
  const identity = await getWebsiteIdentity()
  if (!identity) return <>{children}</>
  const contactSchema = [
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Contact", path: "/site/contact" },
    ]),
    contactPageLd({
      name: `Contact ${identity.tradingName}`,
      description: `Contact ${identity.tradingName} for product enquiries or to lodge a complaint.`,
      path: "/site/contact",
      email: identity.publicEmail,
    }),
    faqLd(contactFaqs(identity, await getT("websiteContact"))),
  ]
  return (
    <>
      <JsonLd id="contact-schema" data={contactSchema} />
      {children}
    </>
  )
}
