import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  host: "quote.acme-lending.example",
  /* The view actually handed to the widget. Asserting only that a page
     rendered would pass for motor too — which is exactly the regression the
     flag gate replaces, so it has to be the journey that is asserted. */
  widgetViews: [] as string[],
  identity: null as unknown,
}))

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: mocks.host }),
}))
// The widget loads FSP's third-party bundle; irrelevant to the notice text.
vi.mock("@/components/insurance/QuickQuoteWidget", () => ({
  QuickQuoteWidget: (props: { view?: string }) => {
    mocks.widgetViews.push(props.view ?? "")
    return null
  },
}))
vi.mock("@/components/insurance/QuickQuoteHeightReporter", () => ({
  QuickQuoteHeightReporter: () => null,
}))

vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "tenant-1" }))
vi.mock("@/lib/config/identity", () => ({
  findLenderIdentity: async () => mocks.identity,
}))

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }))
vi.mock("next/navigation", () => ({ notFound }))

import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import QuotePage from "./page"

const CONFIGURED = {
  FSP_QUICKQUOTE_ENABLED: "true",
  FSP_QUICKQUOTE_EBC: "ebc",
  FSP_QUICKQUOTE_ELEAD: "elead",
  FSP_QUICKQUOTE_BROKER_EMAIL: "insurance@acme-lending.example",
  FSP_QUICKQUOTE_BROKER_NAME: "ACME LENDING (PTY) LTD",
  FSP_QUICKQUOTE_EMBED_ORIGIN: "https://quote.acme-lending.example",
  FSP_QUICKQUOTE_HOSTS: "quote.acme-lending.example",
  NEXT_PUBLIC_WEBSITE_URL: "https://www.acme-lending.example",
  NODE_ENV: "production",
}

async function render() {
  return renderToStaticMarkup(await QuotePage({ searchParams: Promise.resolve({}) }))
}

/** Collapses the entity-escaped, line-wrapped JSX back into plain prose. */
function prose(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
}

beforeEach(() => {
  mocks.host = "quote.acme-lending.example"
  mocks.widgetViews.length = 0
  mocks.identity = ACME_LENDER
  for (const [k, v] of Object.entries(CONFIGURED)) vi.stubEnv(k, v)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("quote page — lender identity", () => {
  it("prints the configured lender's identity", async () => {
    const text = prose(await render())
    expect(text).toContain("Acme Lending")
    expect(text).toContain("NCR NCRCP99999")
    expect(text).toContain("FSP 12345")
    expect(text).toContain("Acme Lending (Pty) Ltd is the responsible party")
  })

  it("prints no other lender anywhere in the markup", async () => {
    expectNoOtherLender(await render())
  })

  it("links the privacy notice on the lender's own website", async () => {
    expect(await render()).toContain('href="https://www.acme-lending.example/site/privacy"')
  })

  it("omits the privacy link rather than naming a site when the website URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "")
    const html = await render()
    expect(html).not.toContain("/site/privacy")
    expectNoOtherLender(html)
  })

  it("renders nothing while the lender identity is unconfigured", async () => {
    mocks.identity = null
    expect(await render()).toBe("")
    expect(mocks.widgetViews).toEqual([])
  })

  it("requests no image", async () => {
    expect(await render()).not.toMatch(/<img|\.webp|\.svg/)
  })

  it("ignores a plate hint from the URL", async () => {
    const html = renderToStaticMarkup(
      await QuotePage({ searchParams: Promise.resolve({ plate: "/x.webp" } as { view?: string }) }),
    )
    expect(html).not.toContain("x.webp")
  })
})

describe("quote page — POPIA notice", () => {
  // Contact only follows an affirmative choice — the visitor picks a quote and
  // submits the contact form. The notice must name the lender as the recipient
  // (POPIA s18(1)(c)) rather than leaving the enquiry agentless.
  it("names the lender as the recipient of the enquiry", async () => {
    expect(prose(await render())).toContain(
      "passed to Acme Lending so that an adviser can call you",
    )
  })

  it("conditions contact on the visitor choosing a quote and asking for it", async () => {
    expect(prose(await render())).toContain(
      "If you choose one of the quotes and ask to be contacted",
    )
  })

  // The notice previously claimed the lender receives nothing, in the paragraph
  // directly above one saying an adviser from the lender would call about it. A s18
  // notice that contradicts itself is a defect, so the retired claim is pinned
  // out rather than left to be reintroduced by a future edit.
  it("does not claim the lender receives nothing the visitor enters", async () => {
    const text = prose(await render())
    expect(text).not.toContain("Acme Lending does not receive or store")
  })

  it("names the responsible party and the Regulator", async () => {
    const text = prose(await render())
    expect(text).toContain("responsible party for referring you to this service")
    expect(text).toContain("Information Regulator")
  })

  it("states the no-advice basis", async () => {
    expect(prose(await render())).toContain("No advice is given here")
  })

  it("404s rather than disclosing anything on a non-quote host", async () => {
    mocks.host = "portal.acme-lending.example"
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND")
  })
})

/* The flag is the one lever for retiring a misbehaving journey. It was added
   gating only the marketing page's tab list, which left this host serving the
   whole thing from a bookmark with the flag off — switching it off removed a
   tab and changed nothing about what was reachable. */
describe("quote page — multi-risk flag gates the host", () => {
  const renderView = async (view?: string) =>
    renderToStaticMarkup(await QuotePage({ searchParams: Promise.resolve({ view }) }))

  it.each(["home", "building"])("404s on ?view=%s while the flag is off", async (view) => {
    await expect(renderView(view)).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it.each(["home", "building"])("serves ?view=%s once the flag is on", async (view) => {
    vi.stubEnv("FSP_QUICKQUOTE_MULTI_RISK", "true")
    expect(await renderView(view)).toContain("cf-quote-page")
    expect(mocks.widgetViews.at(-1)).toBe(view)
  })

  // Motor is never flag-gated — it is the journey that is already live.
  it.each([undefined, "motor"])("always serves view %o", async (view) => {
    expect(await renderView(view)).toContain("cf-quote-page")
    expect(mocks.widgetViews.at(-1)).toBe("motor")
  })

  // A junk view falls back to motor rather than 404ing — isQuickQuoteView
  // rejects it before the flag is consulted, so it never looks flag-gated.
  it("falls back to motor for an unrecognised view", async () => {
    expect(await renderView("yacht")).toContain("cf-quote-page")
    expect(mocks.widgetViews.at(-1)).toBe("motor")
  })
})
