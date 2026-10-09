import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

// proxy.ts pulls in the edge auth config at module load; it is irrelevant to
// host→tenant resolution and would need a full NextAuth environment.
vi.mock("@/lib/auth-edge", () => ({ auth: vi.fn() }))

import { resolveTenantSlug, buildTenantHeaders } from "./proxy"

// The deployment's own host map and local tenant (env only since phase 2).
beforeEach(() => {
  process.env.TENANT_HOST_MAP = "app.lender.example=lender"
  process.env.NEXT_PUBLIC_TENANT_SLUG = "lender"
})
afterEach(() => {
  delete process.env.TENANT_HOST_MAP
  delete process.env.NEXT_PUBLIC_TENANT_SLUG
})

function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest
}

describe("resolveTenantSlug ignores what the caller says", () => {
  // The header used to be returned verbatim on the stated assumption that an
  // upstream proxy set it. Verified on the Hostinger host: nginx never sets or
  // strips it, and forwards unknown client headers — so it was a client input.
  it("does not trust an inbound x-tenant-slug", () => {
    expect(resolveTenantSlug(req({
      host: "app.lender.example",
      "x-tenant-slug": "some-other-tenant",
    }))).toBe("lender")
  })

  it("does not let an inbound header conjure a tenant for an unknown host", () => {
    expect(resolveTenantSlug(req({
      host: "unknown.example.com",
      "x-tenant-slug": "lender",
    }))).toBe("unknown")
  })

  it("returns null for an unmapped two-label host, header or not", () => {
    expect(resolveTenantSlug(req({ host: "example.com" }))).toBeNull()
    expect(resolveTenantSlug(req({ host: "example.com", "x-tenant-slug": "lender" }))).toBeNull()
  })
})

describe("host resolution is unchanged", () => {
  it("maps a known hostname to its tenant", () => {
    expect(resolveTenantSlug(req({ host: "app.lender.example" }))).toBe("lender")
  })

  it("ignores the port when matching a host", () => {
    expect(resolveTenantSlug(req({ host: "localhost:3000" }))).toBe("lender")
  })

  it("falls back to the first label of an unmapped subdomain", () => {
    expect(resolveTenantSlug(req({ host: "acme.example.com" }))).toBe("acme")
  })

  it("defaults local development to the deployment's tenant", () => {
    expect(resolveTenantSlug(req({ host: "127.0.0.1:3000" }))).toBe("lender")
  })

  it("returns null when there is no host at all", () => {
    expect(resolveTenantSlug(req({}))).toBeNull()
  })
})

describe("buildTenantHeaders never lets a client value through", () => {
  // This is the line the whole trust boundary rests on, and inline in the
  // middleware body it was only reachable by invoking the entire handler —
  // so deleting it left every test green.
  it("strips an inbound x-tenant-slug when the host resolves to nothing", () => {
    const out = buildTenantHeaders(req({ host: "example.com", "x-tenant-slug": "attacker" }), null)
    expect(out.get("x-tenant-slug")).toBeNull()
  })

  it("overwrites an inbound x-tenant-slug with the resolved tenant", () => {
    const out = buildTenantHeaders(
      req({ host: "app.lender.example", "x-tenant-slug": "attacker" }),
      "lender",
    )
    expect(out.get("x-tenant-slug")).toBe("lender")
  })

  it("sets the resolved tenant when the client sent no header", () => {
    const out = buildTenantHeaders(req({ host: "app.lender.example" }), "lender")
    expect(out.get("x-tenant-slug")).toBe("lender")
  })

  it("preserves the request's other headers", () => {
    const out = buildTenantHeaders(
      req({ host: "app.lender.example", "x-tenant-slug": "attacker", cookie: "session=abc" }),
      "lender",
    )
    expect(out.get("cookie")).toBe("session=abc")
    expect(out.get("host")).toBe("app.lender.example")
  })

  // The end-to-end property: whatever the caller sends, what reaches the app is
  // the edge's answer for that host.
  it("yields the edge's answer regardless of what the caller claimed", () => {
    const request = req({ host: "app.lender.example", "x-tenant-slug": "some-other-tenant" })
    const out = buildTenantHeaders(request, resolveTenantSlug(request))
    expect(out.get("x-tenant-slug")).toBe("lender")
  })
})

describe("host normalisation", () => {
  // A Host is case-insensitive and may carry a root-zone trailing dot, but the
  // map is exact-match. Un-normalised these fell to the first-label branch and
  // produced a slug naming no tenant — which getResolvedTenantId now treats as
  // a failure, so the quirk would 500 a staff page rather than degrade quietly.
  it("matches the map regardless of host casing", () => {
    expect(resolveTenantSlug(req({ host: "App.Lender.example" }))).toBe("lender")
    expect(resolveTenantSlug(req({ host: "APP.LENDER.EXAMPLE" }))).toBe("lender")
  })

  it("matches the map despite a root-zone trailing dot", () => {
    expect(resolveTenantSlug(req({ host: "app.lender.example." }))).toBe("lender")
  })

  it("lowercases a subdomain slug it falls back to", () => {
    expect(resolveTenantSlug(req({ host: "ACME.example.com" }))).toBe("acme")
  })
})
