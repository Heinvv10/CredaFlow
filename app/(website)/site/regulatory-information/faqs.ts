/**
 * Regulatory FAQ source for /site/regulatory-information.
 *
 * Used by both the (server-component) page and the layout so the rendered
 * FAQ items always match the FAQPage JSON-LD schema. Google penalises
 * FAQPage markup that doesn't match what's visible on the page.
 *
 * Every identifier comes from the tenant's own LenderIdentity — never inline
 * regulator values here.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"

export interface RegulatoryFaq {
  question: string
  answer: string
}

function contactAnswer(identity: LenderIdentity): string {
  const brand = identity.tradingName
  if (!identity.publicWhatsapp) return `You can contact ${brand} by phone on ${identity.publicPhone}, or by email at ${identity.publicEmail}.`
  if (identity.publicWhatsappE164 === identity.publicPhoneE164) {
    return `You can contact ${brand} by phone or WhatsApp on ${identity.publicPhone}, or by email at ${identity.publicEmail}.`
  }
  return `You can contact ${brand} by phone on ${identity.publicPhone}, on WhatsApp on ${identity.publicWhatsapp}, or by email at ${identity.publicEmail}.`
}

export function regulatoryFaqs(identity: LenderIdentity): RegulatoryFaq[] {
  const brand = identity.tradingName
  return [
    {
      question: `What is ${brand}?`,
      answer: `${brand} is a South African financial services and credit provider brand operated by ${identity.legalName}.`,
    },
    {
      question: `Is ${brand} registered with the NCR?`,
      answer: `Yes. ${identity.legalName} is registered with the National Credit Regulator under NCR registration number ${identity.ncrNumber}.`,
    },
    {
      question: `Is ${brand} authorised by the FSCA?`,
      answer: `${identity.legalName} is listed by the Financial Sector Conduct Authority as an authorised financial services provider with FSP number ${identity.fspNumber}.`,
    },
    {
      question: `What is ${brand}'s company registration number?`,
      answer: `${identity.legalName}'s company registration number is ${identity.companyRegNumber}.`,
    },
    {
      question: `Where is ${brand} based?`,
      answer: `${brand}'s public office address is ${identity.registeredOfficeLines.join(", ")}.`,
    },
    {
      question: `How can I contact ${brand}?`,
      answer: contactAnswer(identity),
    },
  ]
}
