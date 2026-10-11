import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  host: "www.acme-lending.example",
  notFoundCalls: 0,
  /* The panel is a client component driving a third-party iframe. What this
     file tests is the GATE and what the page offers — so the panel is stubbed
     to a marker carrying the props that decide both. */
  panelProps: [] as Record<string, unknown>[],
  identity: null as unknown,
}))

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: mocks.host }),
}))

vi.mock("next/navigation", () => ({
  notFound: () => {
    mocks.notFoundCalls += 1
    // The real notFound() throws to halt rendering; mirror that, or the page
    // would carry on and the test would assert against markup a visitor never
    // sees.
    throw new Error("NEXT_NOT_FOUND")
  },
}))

vi.mock("@/components/seo/JsonLd", () => ({ JsonLd: () => null }))
vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: async () => mocks.identity }))
vi.mock("@/components/insurance/QuickQuotePanel", () => ({
  QuickQuotePanel: (props: Record<string, unknown>) => {
    mocks.panelProps.push(props)
    return <div data-testid="quote-panel" />
  },
}))

import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import InsuranceQuotesPage, { generateMetadata } from "./page"

const ORIGIN = "https://quote.acme-lending.example"

async function render(view?: string | string[]) {
  return renderToStaticMarkup(
    await InsuranceQuotesPage({ searchParams: Promise.resolve({ view }) }),
  )
}

/* Shared because a beforeEach declared inside a describe does NOT run for a
   sibling describe. Left inline, the second block below ran with whatever the
   previous test had assigned to process.env — its flag-off cases inherited the
   flag ON and reported the fallback as broken when it was not. */
function configureQuickQuote() {
  mocks.host = "www.acme-lending.example"
  mocks.notFoundCalls = 0
  mocks.panelProps.length = 0
  process.env.FSP_QUICKQUOTE_ENABLED = "true"
  process.env.FSP_QUICKQUOTE_EBC = "ebc"
  process.env.FSP_QUICKQUOTE_ELEAD = "elead"
  process.env.FSP_QUICKQUOTE_BROKER_EMAIL = "broker@example.com"
  process.env.FSP_QUICKQUOTE_BROKER_NAME = "Broker"
  process.env.FSP_QUICKQUOTE_EMBED_ORIGIN = ORIGIN
  process.env.FSP_QUICKQUOTE_HOSTS = "quote.acme-lending.example"
  process.env.FSP_QUICKQUOTE_FRAME_ANCESTORS =
    "https://acme-lending.example,https://www.acme-lending.example,https://staging.acme-lending.example"
  mocks.identity = ACME_LENDER
  // Deleted, not stubbed: the tests below assign to process.env directly and
  // vi.unstubAllEnvs() does not undo that, so without this the first test to
  // switch the flag on would leave it on for every test after it — and the
  // flag-off floor would pass while asserting nothing.
  delete process.env.FSP_QUICKQUOTE_MULTI_RISK
}

describe("insurance quotes page", () => {
  beforeEach(configureQuickQuote)

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("prints the configured lender in the FAIS footnote and the markup names no other", async () => {
    const html = await render()
    expect(html).toContain("Acme Lending")
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(
      "Acme Lending is an authorised Financial Services Provider (FSP 12345)",
    )
    expectNoOtherLender(html)
  })

  it("takes the metadata title from the identity and offers no plate", async () => {
    expect((await generateMetadata()).title).toBe("Compare car insurance quotes | Acme Lending")
    await render()
    expect(JSON.stringify(mocks.panelProps.at(-1)?.plates ?? {})).toBe("{}")
  })

  it("renders nothing while the lender identity is unconfigured", async () => {
    mocks.identity = null
    expect(await render()).toBe("")
    expect(mocks.notFoundCalls).toBe(0)
  })

  it("renders the panel when the embed is fully configured", async () => {
    const html = await render()
    expect(html).toContain('data-testid="quote-panel"')
    expect(mocks.notFoundCalls).toBe(0)
    expect(mocks.panelProps.at(-1)?.origin).toBe(ORIGIN)
  })

  /* The flag-off floor. FSP_QUICKQUOTE_MULTI_RISK is unset by the beforeEach
     above, and unset must mean vehicle-only — this is the default deployment state.
     Asserted as an exact list: a test for "contains motor" would still pass
     if the other two leaked in. */
  it("offers vehicle only while the multi-risk flag is off", async () => {
    await render()
    expect(mocks.panelProps.at(-1)?.views).toEqual(["motor"])
  })

  it("offers all three products once the multi-risk flag is on", async () => {
    process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
    await render()
    expect(mocks.panelProps.at(-1)?.views).toEqual(["motor", "home", "building"])
  })

  /* The heading is a factual claim about what the page compares, so it has to
     follow the flag rather than be written once. With the flag off, promising
     home and buildings would send someone to a tab that is not there; with it
     on, "car insurance quotes" hides two products they came for. */
  it("says car insurance while the flag is off", async () => {
    const html = await render()
    expect(html).toContain("Compare car insurance quotes")
  })

  it("drops the car-only heading once the flag is on", async () => {
    process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
    const html = await render()
    expect(html).toContain("Compare insurance quotes")
    expect(html).not.toContain("Compare car insurance quotes")
  })

  /* The one sentence on this page that legal signed off. It is FAIS copy and
     must survive every heading change above it, character for character. */
  it.each(["true", "false"])(
    "keeps the quote-only disclosure verbatim with the flag %s",
    async (flag) => {
      process.env.FSP_QUICKQUOTE_MULTI_RISK = flag
      expect(await render()).toContain(
        "This is a quote-only service: no advice is given, and no assessment of your",
      )
    },
  )

  /* A page that exists but cannot render the frame is worse than no page: it is
     a dead end reached from a CTA that promised a quote. Each value is dropped
     individually because the config resolves all-or-nothing, and a partially
     configured embed silently mails leads to FSP's own mailbox. */
  it.each([
    "FSP_QUICKQUOTE_ENABLED",
    "FSP_QUICKQUOTE_EBC",
    "FSP_QUICKQUOTE_ELEAD",
    "FSP_QUICKQUOTE_BROKER_EMAIL",
    "FSP_QUICKQUOTE_BROKER_NAME",
    "FSP_QUICKQUOTE_EMBED_ORIGIN",
  ])("404s when %s is missing", async (key) => {
    delete process.env[key]
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.notFoundCalls).toBe(1)
  })

  /* /site/* is classified neither staff-only nor client-only, so this page is
     reachable on app.* and portal.* too — origins that are NOT permitted to
     frame the quote host. Rendering there would advertise a frame the CSP then
     refuses, leaving a dead box. */
  it.each(["app.acme-lending.example", "portal.acme-lending.example"])(
    "404s on %s, which may not frame the quote host",
    async (host) => {
      mocks.host = host
      await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
    },
  )

  it("points the guided alternative back at the enquiry form", async () => {
    expect(await render()).toContain("/site/products/insurance#insurance-enquiry")
  })
})

/* The panel used to start on the first offered view no matter what, so a
   reload — or a link someone sent — dropped a visitor pricing their house back
   onto the car form. The tab now rides in the query string.

   Asserted on the prop rather than on markup because the panel is stubbed
   here: what the page owes it is the RESOLVED view, and a test that scraped a
   rendered tab would be testing the stub. */
describe("insurance quotes page — the tab survives a reload", () => {
  beforeEach(configureQuickQuote)

  const initialView = () => mocks.panelProps.at(-1)?.initialView

  it("opens on the view named in the URL", async () => {
    process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
    await render("building")
    expect(initialView()).toBe("building")
  })

  it("opens on the default product when the URL names none", async () => {
    process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
    await render()
    expect(initialView()).toBe("motor")
  })

  it.each(["yacht", "", "MOTOR", "../home"])(
    "falls back to the default for the unrecognised view %o",
    async (view) => {
      process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
      await render(view)
      expect(initialView()).toBe("motor")
    },
  )

  /* A stale bookmark from when the flag was on. It must open the car tab, not
     a tab the page is not offering — and unlike the quote host, which 404s the
     same request because it would be serving a journey that should not exist,
     a marketing page's worst case is showing its default product. */
  it.each(["home", "building"])(
    "falls back to motor for ?view=%s while multi-risk is off",
    async (view) => {
      const html = await render(view)
      expect(initialView()).toBe("motor")
      expect(mocks.notFoundCalls).toBe(0)
      expect(html).toContain("quote-panel")
    },
  )
})

/* Next returns an ARRAY for a repeated key, so `?view=motor&view=building`
   reaches the page as one — a shape the obvious `string` annotation denies
   exists. It has to be refused rather than indexed into, or which product
   someone sees would depend on how many times the key appears. */
describe("insurance quotes page — a repeated view parameter", () => {
  beforeEach(configureQuickQuote)

  it("falls back rather than picking one of the repeated values", async () => {
    process.env.FSP_QUICKQUOTE_MULTI_RISK = "true"
    await render(["building", "home"])
    expect(mocks.panelProps.at(-1)?.initialView).toBe("motor")
  })
})
