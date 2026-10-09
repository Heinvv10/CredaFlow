import { afterEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { resolveTenantSlug } from "./tenant-routing"
import { DeploymentConfigError } from "@/lib/config/deployment-urls"

function request(url: string, claimedTenant: string) {
  const parsed = new URL(url)
  return new NextRequest(url, {
    headers: {
      host: parsed.host,
      "x-tenant-slug": claimedTenant,
    },
  })
}

afterEach(() => {
  delete process.env.TENANT_HOST_MAP
  delete process.env.NEXT_PUBLIC_TENANT_SLUG
})

describe("proxy tenant routing", () => {
  it("overwrites a caller-supplied tenant with the mapped host", () => {
    process.env.TENANT_HOST_MAP = "app.lender.example=lender, staging.lender.example=lender"
    expect(resolveTenantSlug(request("https://staging.lender.example/api/applications", "other-tenant"))).toBe("lender")
    expect(resolveTenantSlug(request("https://APP.lender.example./api/applications", "other-tenant"))).toBe("lender")
  })

  it("derives an unknown multi-tenant host from its subdomain", () => {
    expect(resolveTenantSlug(request("https://tenant-b.example.test/api/applications", "tenant-a"))).toBe("tenant-b")
  })

  // Without an explicit map entry the subdomain fallback would resolve the
  // QuickQuote host to the tenant slug "quote", which does not exist.
  it("maps a QuickQuote host only when it is listed", () => {
    expect(resolveTenantSlug(request("https://quote.lender.example/quote", "other"))).toBe("quote")
    process.env.TENANT_HOST_MAP = "quote.lender.example=lender"
    expect(resolveTenantSlug(request("https://quote.lender.example/quote", "other"))).toBe("lender")
  })

  it("has no built-in host mapping", () => {
    expect(resolveTenantSlug(request("https://lender.example/", "other"))).toBeNull()
  })

  it("refuses a malformed map instead of guessing", () => {
    process.env.TENANT_HOST_MAP = "app.lender.example:lender"
    expect(() => resolveTenantSlug(request("https://app.lender.example/", "x"))).toThrow(DeploymentConfigError)
  })

  it("does not let a caller override the local development tenant", () => {
    process.env.NEXT_PUBLIC_TENANT_SLUG = "lender"
    expect(resolveTenantSlug(request("http://localhost:3300/api/applications", "other-tenant"))).toBe("lender")
    delete process.env.NEXT_PUBLIC_TENANT_SLUG
    expect(resolveTenantSlug(request("http://localhost:3300/api/applications", "other-tenant"))).toBeNull()
  })
})
