import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { QuickQuoteArrival } from "./QuickQuoteArrival"
import type { ParsedQuote } from "@/lib/insurance/quickquote-bridge"

// The insurer logo URL is scraped from the panel's markup: any host, any size.
// It must reach the browser as-is, not rewritten to the image optimizer (which
// would refuse a host missing from next.config), and stay decorative.
const quote: ParsedQuote = {
  index: 0,
  offeringId: "offering-1",
  insurer: "Example Insurer",
  logoUrl: "https://insurer.example/logo.png",
  premium: 512,
  premiumLabel: "R512",
  excessLabel: "R5 000",
}

describe("QuickQuoteArrival insurer logo", () => {
  it("renders the scraped logo URL unchanged, with an empty alt", () => {
    const html = renderToStaticMarkup(<QuickQuoteArrival quotes={[quote]} panelComplete={false} />)
    expect(html).toMatch(/<img[^>]*src="https:\/\/insurer\.example\/logo\.png"/)
    expect(html).not.toContain("/_next/image")
    expect(html).toMatch(/<img[^>]*alt=""/)
  })

  it("renders no image when the quote has no logo", () => {
    const html = renderToStaticMarkup(<QuickQuoteArrival quotes={[{ ...quote, logoUrl: "" }]} panelComplete={false} />)
    expect(html).not.toContain("<img")
  })
})
