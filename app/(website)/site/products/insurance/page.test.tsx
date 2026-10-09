import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  host: "www.acme-lending.example",
  /* The hero lives inside ProductPageTemplate, which is stubbed below — so the
     hero CTA cannot be asserted from rendered HTML. Capture the props instead.

     (This used to add that "Get instant quotes" was also the panel's own
     button, making a string match on the markup pass without the hero
     changing. That button is gone — the click-to-load gate was removed — so
     the duplicate no longer exists. Asserting on props is still the right
     call, for the stubbing reason above.) */
  templateProps: [] as Record<string, unknown>[],
  identity: null as unknown,
  faqItems: [] as { question: string; answer: string }[][],
  jsonLd: [] as unknown[],
  detailProps: [] as Record<string, unknown>[],
}))

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: mocks.host }),
}))

// Heavy marketing chrome is irrelevant to what this file tests (which of the
// two lead channels the page renders), so it is stubbed. The two channels
// themselves are stubbed to markers so their presence is asserted directly
// rather than inferred from surrounding copy.
vi.mock("@/components/seo/JsonLd", () => ({
  JsonLd: (props: { data: unknown }) => {
    mocks.jsonLd.push(props.data)
    return null
  },
}))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: async () => mocks.identity }))
vi.mock("@/components/website/ProductPageTemplate", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.templateProps.push(props)
    return null
  },
}))
vi.mock("@/components/website/ProductDetailSections", () => ({
  ProductDetailSections: (props: Record<string, unknown>) => {
    mocks.detailProps.push(props)
    return null
  },
}))
vi.mock("@/components/website/FaqAccordion", () => ({
  FaqAccordion: (props: { items: { question: string; answer: string }[] }) => {
    mocks.faqItems.push(props.items)
    return null
  },
}))
vi.mock("@/components/website/InsuranceEnquiryForm", () => ({
  InsuranceEnquiryForm: () => <div data-testid="enquiry-form" />,
}))

import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import InsuranceProductPage, { generateMetadata } from "./page"

const CREDENTIALS = {
  FSP_QUICKQUOTE_ENABLED: "true",
  FSP_QUICKQUOTE_EBC: "ebc-value",
  FSP_QUICKQUOTE_ELEAD: "elead-value",
  FSP_QUICKQUOTE_BROKER_EMAIL: "insurance@acme-lending.example",
  FSP_QUICKQUOTE_BROKER_NAME: "ACME LENDING (PTY) LTD",
  FSP_QUICKQUOTE_EMBED_ORIGIN: "https://quote.acme-lending.example",
  FSP_QUICKQUOTE_HOSTS: "quote.acme-lending.example",
  FSP_QUICKQUOTE_FRAME_ANCESTORS:
    "https://acme-lending.example,https://www.acme-lending.example,https://staging.acme-lending.example",
}

async function render() {
  return renderToStaticMarkup(await InsuranceProductPage())
}

function enable(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({ ...CREDENTIALS, ...overrides })) {
    vi.stubEnv(key, value)
  }
}

beforeEach(() => {
  mocks.host = "www.acme-lending.example"
  mocks.identity = ACME_LENDER
  mocks.faqItems.length = 0
  mocks.jsonLd.length = 0
  mocks.detailProps.length = 0
  mocks.templateProps.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/* Every identity value on this page comes from the tenant's LenderIdentity,
   including the statutory FAIS disclosure. The unconfigured quote host and
   the stubbed children must not hide a leak, so the captured props, the FAQ
   list and the JSON-LD are all searched, not only the markup. */
describe("insurance product page — lender identity", () => {
  async function everything() {
    enable()
    const html = await render()
    return [
      html,
      JSON.stringify(mocks.templateProps),
      JSON.stringify(mocks.detailProps),
      JSON.stringify(mocks.faqItems),
      JSON.stringify(mocks.jsonLd),
    ].join("\n")
  }

  it("prints the configured FSP number and brand in the disclosure copy", async () => {
    const html = await render()
    expect(html).toContain("Acme Lending is a FAIS-authorised intermediary (FSP 12345)")
    expect(JSON.stringify(mocks.templateProps)).toContain("Authorised Financial Services Provider (FSP 12345)")
  })

  it("prints the FSP number and brand in the regulatory FAQ, and the JSON-LD matches the list rendered", async () => {
    await render()
    const faqs = mocks.faqItems.at(-1) ?? []
    const regulatory = faqs.find((f) => f.question === "What regulatory framework applies?")
    expect(regulatory?.answer).toContain("Acme Lending acts as an authorised Financial Services Provider")
    expect(regulatory?.answer).toContain("FSP 12345.")
    expect(faqs[0]?.question).toBe("What is the Acme Lending insurance enquiry pathway?")
    const faqNode = (mocks.jsonLd.at(-1) as { "@type": string; mainEntity: { name: string }[] }[]).find(
      (n) => n["@type"] === "FAQPage",
    )
    expect(faqNode?.mainEntity.map((q) => q.name)).toEqual(faqs.map((f) => f.question))
  })

  it("prints no other lender in the markup, props, FAQs or JSON-LD", async () => {
    expectNoOtherLender(await everything())
  })

  it("carries no hero image, so none is requested", async () => {
    await render()
    expect(JSON.stringify(mocks.templateProps)).not.toMatch(/\.webp|bgImage/)
  })

  it("links only to pages that exist", async () => {
    const all = await everything()
    expect(all).not.toMatch(/\/site\/(about|faq|how-it-works|pricing)|\/site\/products(?!\/insurance)|\/blog/)
  })

  it("renders nothing while the lender identity is unconfigured", async () => {
    mocks.identity = null
    expect(await render()).toBe("")
  })

  it("builds metadata from the identity", async () => {
    const meta = await generateMetadata()
    expect(meta.title).toBe("Credit-Life & Funeral Insurance Enquiries | Acme Lending")
    expectNoOtherLender(JSON.stringify(meta))
  })

  it("gives the unconfigured tenant no-index metadata that names no one", async () => {
    mocks.identity = null
    const meta = await generateMetadata()
    expect(meta.robots).toEqual({ index: false, follow: false })
    expectNoOtherLender(JSON.stringify(meta))
    expect(JSON.stringify(meta)).not.toMatch(/acme/i)
  })
})

describe("insurance product page — QuickQuote gating", () => {
  beforeEach(() => {
    mocks.templateProps.length = 0
  })

  // The unconfigured state is every environment until FSP's contract lands, so
  // it is the case that must be proven, not assumed.
  it("renders no quote section when the embed is unconfigured", async () => {
    const html = await render()

    expect(html).not.toContain('id="insurance-quote"')
    expect(html).not.toContain("quote.acme-lending.example")
  })

  it("still renders the enquiry form when the embed is unconfigured", async () => {
    expect(await render()).toContain('data-testid="enquiry-form"')
  })

  it("renders the quote section once fully configured", async () => {
    enable()

    expect(await render()).toContain('id="insurance-quote"')
  })

  // The quote CTA measured 3136px down a 6332px page — 50%, 2.7 screens,
  // behind two explainer sections that live inside the shared
  // ProductPageTemplate and so cannot be reordered from here. The hero's
  // primary action is overridden instead, which is the only thing putting the
  // comparison surface within one click of the top.
  it("makes the quote the hero's primary action once configured", async () => {
    enable()
    await render()

    const ctas = mocks.templateProps.at(-1)?.ctas as
      | { primary: { label: string; href: string }; secondary: { label: string; href: string } }
      | undefined
    // The quote surface moved to its own page, so the hero CTA is a
    // navigation rather than an anchor into this one. Asserting the exact
    // path, not just "not the anchor": a CTA pointing at a route that does not
    // exist fails the same way the old dead anchor did.
    expect(ctas?.primary).toEqual({
      label: "Get instant quotes",
      href: "/site/products/insurance/quotes",
    })
    expect(ctas?.secondary.href).toBe("#insurance-enquiry")
  })

  // The inverse matters more than the positive: advertising a surface that
  // will not render sends the visitor to an anchor that does not exist.
  it("keeps the enquiry CTAs in the hero when the embed is unconfigured", async () => {
    await render()

    const ctas = mocks.templateProps.at(-1)?.ctas as
      | { primary: { label: string; href: string } }
      | undefined
    // Advertising a surface that will not render sends the visitor to an
    // anchor that does not exist on the page.
    expect(ctas?.primary.href).not.toBe("/site/products/insurance/quotes")
    expect(ctas?.primary.label).toBe("Enquire about insurance")
  })

  // The widget writes nothing to our database, so if it ever displaced the
  // enquiry form the CRM would stop receiving insurance leads entirely. Both
  // channels are required to coexist.
  it("keeps the enquiry form alongside the widget", async () => {
    enable()

    const html = await render()
    expect(html).toContain('id="insurance-quote"')
    expect(html).toContain('data-testid="enquiry-form"')
  })

  it("orders the quote section above the enquiry form", async () => {
    enable()

    const html = await render()
    expect(html.indexOf('id="insurance-quote"')).toBeLessThan(
      html.indexOf('id="insurance-enquiry"'),
    )
  })

  // A missing credential must take the whole section down, not render a widget
  // that quietly mails leads to FSP's default itteam@ mailbox.
  it.each([
    "FSP_QUICKQUOTE_EBC",
    "FSP_QUICKQUOTE_ELEAD",
    "FSP_QUICKQUOTE_BROKER_EMAIL",
    "FSP_QUICKQUOTE_BROKER_NAME",
  ])("renders no quote section when %s is blank", async (key) => {
    enable({ [key]: "" })

    expect(await render()).not.toContain('id="insurance-quote"')
  })

  it("renders no quote section when the embed origin is missing", async () => {
    enable({ FSP_QUICKQUOTE_EMBED_ORIGIN: "" })

    expect(await render()).not.toContain('id="insurance-quote"')
  })

  it("renders no quote section when the flag is off but credentials exist", async () => {
    enable({ FSP_QUICKQUOTE_ENABLED: "false" })

    expect(await render()).not.toContain('id="insurance-quote"')
  })

  it("renders no quote section when the embed origin is a session-bearing host", async () => {
    enable({
      FSP_QUICKQUOTE_EMBED_ORIGIN: "https://portal.acme-lending.example",
      NODE_ENV: "production",
    })

    expect(await render()).not.toContain('id="insurance-quote"')
  })
})

describe("insurance product page — embedding host gate", () => {
  // /site/* is classified neither staff-only nor client-only, so this page is
  // reachable on the session-bearing hosts too. Those origins are not in
  // frame-ancestors, so offering the widget there produced a button whose
  // frame CSP then refused in silence.
  it.each(["app.acme-lending.example", "portal.acme-lending.example"])(
    "renders no quote section on the non-marketing host %s",
    async (host) => {
      enable({ NODE_ENV: "production" })
      mocks.host = host

      expect(await render()).not.toContain('id="insurance-quote"')
    },
  )

  it.each([
    "acme-lending.example",
    "www.acme-lending.example",
    "staging.acme-lending.example",
  ])("renders the quote section on the marketing host %s", async (host) => {
    enable({ NODE_ENV: "production" })
    mocks.host = host

    expect(await render()).toContain('id="insurance-quote"')
  })

  it("still renders the enquiry form on a non-marketing host", async () => {
    enable({ NODE_ENV: "production" })
    mocks.host = "portal.acme-lending.example"

    expect(await render()).toContain('data-testid="enquiry-form"')
  })

  it("renders no quote section when the host header is absent", async () => {
    enable({ NODE_ENV: "production" })
    mocks.host = ""

    expect(await render()).not.toContain('id="insurance-quote"')
  })

  it("ignores a port on the host header", async () => {
    enable()
    mocks.host = "www.acme-lending.example:3000"

    expect(await render()).toContain('id="insurance-quote"')
  })
})
