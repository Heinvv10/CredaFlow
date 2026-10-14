import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A lender's custom domain (Tenant.domain) resolves its host BEFORE the edge's
// tenant slug (lib/tenant.ts), so a domain that names a host the deployment
// already serves would take that host over. B1, PR #91.
const h = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findFirst: h.findFirst } } }))

import { readFileSync } from "node:fs"
import path from "node:path"
import { isReservedDeploymentHost, normaliseTenantDomain, tenantDomainRefusal, tenantSlugRefusal } from "./tenant-domain"

beforeEach(() => {
  h.findFirst.mockReset().mockResolvedValue(null)
  vi.stubEnv("OPERATOR_APP_HOST", "console.platform.example")
  vi.stubEnv("STAFF_APP_HOST", "app.platform.example")
  vi.stubEnv("TENANT_HOST_MAP", "staff.acme.example=acme,portal.acme.example=acme")
  vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://portal.platform.example")
  vi.stubEnv("NEXTAUTH_URL", "https://app.platform.example")
})
afterEach(() => vi.unstubAllEnvs())

describe("normaliseTenantDomain", () => {
  it("lower-cases, trims and drops a trailing dot", () => {
    expect(normaliseTenantDomain("  Lender.Example.COM. ")).toEqual({ ok: true, domain: "lender.example.com" })
  })
  it("treats blank as no domain", () => {
    expect(normaliseTenantDomain("  ")).toEqual({ ok: true, domain: null })
    expect(normaliseTenantDomain(null)).toEqual({ ok: true, domain: null })
  })
  it.each(["not a host", "http://x.example", "x.example/path", "localhost", "x..example", 42])("refuses %j", (raw) => {
    expect(normaliseTenantDomain(raw).ok).toBe(false)
  })
})

describe("tenantDomainRefusal", () => {
  it.each([
    ["the operator console host", "console.platform.example"],
    ["the staff host", "app.platform.example"],
    ["a TENANT_HOST_MAP host", "portal.acme.example"],
    ["the portal host", "portal.platform.example"],
  ])("refuses %s", async (_label, domain) => {
    expect(await tenantDomainRefusal(domain, null)).toMatch(/already serves/)
  })

  it("refuses another lender's subdomain-fallback host (first label = its slug)", async () => {
    h.findFirst.mockImplementation(async (a: { where: { slug?: string } }) => (a.where.slug === "acme" ? { slug: "acme" } : null))
    expect(await tenantDomainRefusal("acme.lenders.example", "t-beta")).toMatch(/acme/)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ slug: "acme", NOT: { id: "t-beta" } }) }))
  })

  it("refuses a domain another lender already holds", async () => {
    h.findFirst.mockImplementation(async (a: { where: { domain?: string } }) => (a.where.domain ? { slug: "acme" } : null))
    expect(await tenantDomainRefusal("lending.example.com", "t-beta")).toMatch(/another lender/)
  })

  it("accepts a domain of the lender's own", async () => {
    expect(await tenantDomainRefusal("beta-lending.example", "t-beta")).toBeNull()
  })

  it.each([
    ["an FSP QuickQuote host", "FSP_QUICKQUOTE_HOSTS", "quote.lender.example,quote2.lender.example", "quote2.lender.example"],
    ["the QuickQuote embed origin's host", "FSP_QUICKQUOTE_EMBED_ORIGIN", "https://embed.lender.example", "embed.lender.example"],
    ["a QuickQuote frame ancestor's host", "FSP_QUICKQUOTE_FRAME_ANCESTORS", "https://www.lender.example", "www.lender.example"],
  ])("refuses %s (breaker repro 4)", async (_label, name, value, domain) => {
    vi.stubEnv(name, value)
    expect(await tenantDomainRefusal(domain, null)).toMatch(/already serves/)
  })
})

// The proxy and the QuickQuote host gate decide which hosts this deployment
// serves from env. Every host-bearing variable they read must be reserved,
// so a new one cannot be added to the proxy and forgotten here.
describe("reserved hosts cover every host variable the proxy reads", () => {
  const SOURCES = ["proxy.ts", "lib/proxy/tenant-routing.ts", "lib/proxy/operator-host.ts", "lib/config/deployment-urls.ts", "lib/insurance/quickquote-config.ts"]
  const read = SOURCES.flatMap((file) => [
    ...readFileSync(path.join(process.cwd(), file), "utf8").matchAll(/(?:env\.|(?:listFrom|value)\(env, ")([A-Z][A-Z0-9_]+)/g),
  ].map((m) => m[1]))
  const hostVars = [...new Set(read)].filter((name) => /HOST|URL|ORIGIN|ANCESTORS/.test(name)).sort()

  it("finds the host variables (the scan itself works)", () => {
    expect(hostVars).toEqual(expect.arrayContaining(["OPERATOR_APP_HOST", "STAFF_APP_HOST", "TENANT_HOST_MAP", "FSP_QUICKQUOTE_HOSTS", "FSP_QUICKQUOTE_EMBED_ORIGIN"]))
  })

  it("reserves the host each of them names", () => {
    const sample = (name: string, host: string) =>
      name === "TENANT_HOST_MAP" ? `${host}=acme` : /_HOSTS?$/.test(name) ? host : `https://${host}`
    for (const name of hostVars) {
      vi.unstubAllEnvs()
      const host = `${name.toLowerCase().replace(/_/g, "-")}.reserved.example`
      vi.stubEnv(name, sample(name, host))
      expect(isReservedDeploymentHost(host), name).toBe(true)
    }
  })
})

describe("tenantSlugRefusal — a new lender's subdomain host must not be another lender's domain", () => {
  it("refuses a slug that is the first label of an existing lender's 3+-label domain", async () => {
    h.findFirst.mockResolvedValue({ slug: "acme", domain: "beta.lenders.example" })
    expect(await tenantSlugRefusal("beta")).toMatch(/beta\.lenders\.example/)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { domain: { startsWith: "beta." } } }))
  })

  it("accepts a slug when the matching domain is a bare 2-label domain (no subdomain fallback)", async () => {
    h.findFirst.mockResolvedValue({ slug: "acme", domain: "beta.example" })
    expect(await tenantSlugRefusal("beta")).toBeNull()
  })
})
