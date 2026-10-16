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

import { DELETED_SITE_ROUTES, PUBLIC_SITE_ROUTES } from "./routes"
import sitemap from "@/app/sitemap"
import robots from "@/app/robots"
import proxy from "@/proxy"
import * as websiteLayout from "@/app/(website)/layout"
import * as homePage from "@/app/page"
import * as llms from "@/app/llms.txt/route"

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

  it("the sitemap is empty, and robots names no host, when the site URL is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "")
    expect(await sitemap()).toEqual([])
    const r = robots()
    expect(r.sitemap).toBeUndefined()
    expect(r.host).toBeUndefined()
  })

  it("robots allows the kept routes and none of the deleted ones", () => {
    const allowed = [robots().rules].flat().flatMap((rule) => [rule.allow ?? []].flat())
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
