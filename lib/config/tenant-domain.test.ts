import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A lender's custom domain (Tenant.domain) resolves its host BEFORE the edge's
// tenant slug (lib/tenant.ts), so a domain that names a host the deployment
// already serves would take that host over. B1, PR #91.
const h = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findFirst: h.findFirst } } }))

import { normaliseTenantDomain, tenantDomainRefusal } from "./tenant-domain"

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
})
