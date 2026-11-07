import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// proxy.ts wraps its handler in the edge auth; with the wrapper as identity
// the default export IS the handler, called here as an anonymous visitor.
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))
// The sitemap reads the identity: the insurance page is mapped only for a lender with an FSP number.
const website = vi.hoisted(() => ({ fspNumber: "12345" as string | null }))
vi.mock("@/lib/website/identity", async () => {
  const { ACME_LENDER } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getWebsiteIdentity: async () => ({ ...ACME_LENDER, fspNumber: website.fspNumber }) }
})

vi.mock("@/lib/jurisdiction/load.server", () => ({ ensureActiveJurisdiction: async () => ({}) }))
vi.mock("@/lib/public-loan-products-server", () => ({ getTenantPublicProductsServer: async () => [] }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => "t1" }))
vi.mock("@/lib/config/identity", async () => {
  const { ACME_LENDER } = await import("@/lib/config/__fixtures__/lender-identity")
  return { findLenderIdentity: async () => ({ ...ACME_LENDER, fspNumber: "12345" }) }
})

import { DELETED_SITE_ROUTES, NCA_ONLY_SITE_ROUTES, PUBLIC_SITE_ROUTES } from "./routes"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import sitemap from "@/app/sitemap"
import robots from "@/app/robots"
import proxy from "@/proxy"
import * as websiteLayout from "@/app/(website)/layout"
import * as homePage from "@/app/page"
import * as llms from "@/app/llms.txt/route"
import * as sitemapRoute from "@/app/sitemap"
import * as robotsRoute from "@/app/robots"
import { generateMetadata as websiteLayoutMetadata } from "@/app/(website)/layout"

// Decision: the public site is the kept pages only.
const APP = path.join(process.cwd(), "app")

/** Every page route under app/, as URL paths (route groups stripped). */
function pageRoutes(dir = APP, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (!statSync(full).isDirectory()) {
      if (/^page\.(tsx|ts)$/.test(entry)) out.push(prefix || "/")
      continue
    }
    if (entry === "api" || entry.startsWith("_") || entry === "__tests__") continue
    out.push(...pageRoutes(full, /^\(.*\)$/.test(entry) ? prefix : `${prefix}/${entry}`))
  }
  return out
}

const visit = async (pathname: string) => {
  const req = new NextRequest(`http://localhost${pathname}`) as NextRequest & { auth: null }
  req.auth = null
  return (proxy as unknown as (r: NextRequest) => Promise<Response> | Response)(req)
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.acme-lending.example"))
afterEach(() => vi.unstubAllEnvs())

describe("public site route set", () => {
  // A build has no request tenant: a prerendered page would either fail the
  // build or bake one tenant's identity into every tenant's HTML.
  it("the website renders per request, never prerendered", () => {
    expect(websiteLayout.dynamic).toBe("force-dynamic")
    expect(homePage.dynamic).toBe("force-dynamic")
    expect(llms.dynamic).toBe("force-dynamic")
  })

  // Both read the lender's jurisdiction from the database: prerendered at build they would bake in the fail-closed ZA one.
  it("the sitemap and robots.txt render per request, since they depend on the lender's jurisdiction", () => {
    expect(sitemapRoute.dynamic).toBe("force-dynamic")
    expect(robotsRoute.dynamic).toBe("force-dynamic")
  })

  it("every kept route has a page", () => {
    const routes = pageRoutes()
    for (const route of PUBLIC_SITE_ROUTES) expect(routes, route).toContain(route)
  })

  it("no deleted route has a page", () => {
    const routes = pageRoutes()
    for (const route of DELETED_SITE_ROUTES) expect(routes, route).not.toContain(route)
    expect(routes.filter((r) => r.startsWith("/blog"))).toEqual([])
    expect(existsSync(path.join(APP, "(website)", "site", "page.tsx"))).toBe(false)
  })

  it("the sitemap lists exactly the kept routes, on the deployment's own site URL", async () => {
    expect((await sitemap()).map((entry) => entry.url)).toEqual(PUBLIC_SITE_ROUTES.map((r) => `https://www.acme-lending.example${r === "/" ? "" : r}`))
  })

  // #143 blind review (LOW): the insurance page 404s without an FSP number.
  it("leaves the insurance page out of the sitemap for a lender with no FSP number", async () => {
    website.fspNumber = null
    try {
      const urls = (await sitemap()).map((entry) => entry.url)
      expect(urls).not.toContain("https://www.acme-lending.example/site/products/insurance")
      expect(urls).toContain("https://www.acme-lending.example/site/apply")
    } finally {
      website.fspNumber = "12345"
    }
  })

  it("leaves the insurance and regulatory pages out of the sitemap for a Kenyan lender, which has neither", async () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    try {
      const urls = (await sitemap()).map((entry) => entry.url)
      for (const route of NCA_ONLY_SITE_ROUTES) expect(urls).not.toContain(`https://www.acme-lending.example${route}`)
      expect(urls).toContain("https://www.acme-lending.example/site/apply")
      expect(urls).toContain("https://www.acme-lending.example/site/terms")
    } finally {
      resetActiveJurisdiction()
    }
  })

  it("robots allows neither NCA-only page for a Kenyan lender, and the rest as before", async () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    try {
      const allowed = [(await robots()).rules].flat().flatMap((rule) => [rule.allow ?? []].flat())
      for (const route of NCA_ONLY_SITE_ROUTES) expect(allowed).not.toContain(route)
      expect(allowed).toContain("/site/apply")
      expect(allowed).toContain("/site/privacy")
    } finally {
      resetActiveJurisdiction()
    }
  })

  it("the sitemap is empty, and robots names no host, when the site URL is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "")
    expect(await sitemap()).toEqual([])
    const r = await robots()
    expect(r.sitemap).toBeUndefined()
    expect(r.host).toBeUndefined()
  })

  it("robots allows the kept routes and none of the deleted ones", async () => {
    const allowed = [(await robots()).rules].flat().flatMap((rule) => [rule.allow ?? []].flat())
    for (const route of PUBLIC_SITE_ROUTES) expect(allowed).toContain(route)
    for (const route of DELETED_SITE_ROUTES) expect(allowed).not.toContain(route)
  })

  it("the proxy redirects the old /site index to the home page", async () => {
    const res = await visit("/site")
    expect(res.status).toBe(308)
    expect(res.headers.get("location")).toBe("http://localhost/")
  })

  it("the proxy no longer treats the deleted blog as a public route", async () => {
    const res = await visit("/blog")
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toMatch(/\/login\?callbackUrl=%2Fblog$/)
  })

  it("the proxy serves the kept pages to an anonymous visitor", async () => {
    for (const route of PUBLIC_SITE_ROUTES) {
      const res = await visit(route)
      expect(res.headers.get("location"), route).toBeNull()
    }
  })
})

describe("the fallback metadata of a (website) page", () => {
  it("calls a South African lender a registered credit provider, and a Kenyan one a credit provider in Kenya", async () => {
    expect((await websiteLayoutMetadata()).description).toBe("Acme Lending — registered credit provider NCRCP99999.")
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    try {
      const meta = await websiteLayoutMetadata()
      expect(meta.description).toBe("Acme Lending — credit provider in Kenya.")
      expect(JSON.stringify(meta)).not.toMatch(/registered|NCR/)
    } finally {
      resetActiveJurisdiction()
    }
  })
})

describe("the lists of NCA-only website pages", () => {
  const registry = import.meta.glob<{ default: Record<string, unknown> }>("../registry/nca-only/*.ts", { eager: true })
  const toRoute = (surface: string) => surface.replace(/^app\/\(website\)/, "").replace(/\/page\.tsx$/, "")

  // The census registry says which pages are gated, NCA_ONLY_SITE_ROUTES feeds the sitemap and robots.txt, and the chat
  // knowledge filters its page list by the same constant: one list that disagrees with the registry advertises a page that 404s.
  it("NCA_ONLY_SITE_ROUTES is exactly the website pages the NCA-only registry gates", () => {
    const gated = Object.values(registry)
      .flatMap((m) => Object.keys(m.default))
      .filter((surface) => surface.startsWith("app/(website)/") && surface.endsWith("/page.tsx"))
      .map(toRoute)
    expect([...gated].sort()).toEqual([...NCA_ONLY_SITE_ROUTES].sort())
  })

  it("every NCA-only route has a page, and none is in the lists a Kenyan site serves from", async () => {
    const routes = pageRoutes()
    for (const route of NCA_ONLY_SITE_ROUTES) expect(routes, route).toContain(route)
    const { buildKnowledge } = await import("@/lib/website-chat/knowledge")
    const text = buildKnowledge({ identity: { ...(await import("@/lib/config/__fixtures__/lender-identity")).ACME_LENDER }, products: [], insurance: [], site: { code: "KE", nca: false, countryName: "Kenya" } })
    for (const route of NCA_ONLY_SITE_ROUTES) expect(text).not.toContain(route)
  })
})

describe("home page metadata", () => {
  it("is titled for the lender's own country and sells no insurance outside the NCA", async () => {
    const za = await homePage.generateMetadata()
    expect(za.title).toBe("Credit and insurance — South Africa | Acme Lending")
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    try {
      const ke = await homePage.generateMetadata()
      expect(ke.title).toBe("Credit — Kenya | Acme Lending")
      expect(JSON.stringify(ke)).not.toMatch(/South Africa|insurance|POPIA|NCR/i)
    } finally {
      resetActiveJurisdiction()
    }
  })
})

describe("llms.txt", () => {
  const body = async () => (await llms.GET()).text()

  it("describes a South African lender as before", async () => {
    const text = await body()
    expect(text).toContain("/site/products/insurance")
    expect(text).toContain("- Privacy and POPIA:")
    expect(text).toContain("- Regulatory information:")
    expect(text).toContain("- NCR registration: NCRCP99999")
    expect(text).toContain("- Country: South Africa")
  })

  it("names Kenya, and no South African page or registration, for a Kenyan lender", async () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    try {
      const text = await body()
      expect(text).toContain("- Country: Kenya")
      expect(text).not.toMatch(/South Africa|POPIA|NCR|FSP|\/site\/products\/insurance|regulatory-information/)
      expect(text).toContain("/site/privacy")
    } finally {
      resetActiveJurisdiction()
    }
  })
})
