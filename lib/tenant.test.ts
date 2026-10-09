import { describe, it, expect, vi, beforeEach } from "vitest"

// getTenantFeatures pulls in prisma (which opens a real DB connection +
// keepalive at import time) and Next's request-scoped headers()/unstable_cache
// — stub all three so the resolver can run in a plain vitest/node environment.
// vi.mock factories are hoisted above imports, so the mock fns they close over
// must be created via vi.hoisted rather than plain top-level consts.
const { findUniqueTenant, findFirstTenant, findUniqueTenantConfig, headersGet } = vi.hoisted(() => ({
  findUniqueTenant: vi.fn(),
  findFirstTenant: vi.fn(),
  findUniqueTenantConfig: vi.fn(),
  headersGet: vi.fn(),
}))
vi.mock("./prisma", () => ({
  prisma: {
    tenant: { findUnique: findUniqueTenant, findFirst: findFirstTenant },
    tenantConfig: { findUnique: findUniqueTenantConfig },
  },
}))

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
}))

// unstable_cache is a request-scoped, on-disk cache with no meaning in a unit
// test — bypass it so getTenantConfig's wrapped function runs directly.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}))

import { resolveFeatureFlags, getTenantFeatures, getResolvedTenantId, type TenantConfigData } from "./tenant"

function config(overrides: Partial<TenantConfigData>): TenantConfigData {
  return {
    id: "config-1",
    tenantId: "tenant-1",
    primaryColor: "#000000",
    secondaryColor: "#000000",
    darkColor: "#000000",
    logoUrl: null,
    faviconUrl: null,
    brandName: null,
    featureLms: true,
    featureCrm: false,
    featureIms: false,
    featureBureauSubmission: false,
    featureMarketing: true,
    featurePortal: true,
    featureReports: true,
    ncrNumber: null,
    fscaNumber: null,
    companyRegNumber: null,
    ...overrides,
  }
}

describe("resolveFeatureFlags", () => {
  it("no TenantConfig row resolves both flags OFF (matches sidebar's hidden default)", () => {
    expect(resolveFeatureFlags(null)).toEqual({ featureCrm: false, featureIms: false, featureBureauSubmission: false })
  })

  it("flags ON in the row resolve ON", () => {
    expect(resolveFeatureFlags(config({ featureCrm: true, featureIms: true }))).toEqual({
      featureCrm: true,
      featureIms: true,
      featureBureauSubmission: false,
    })
  })

  it("flags OFF in the row resolve OFF", () => {
    expect(resolveFeatureFlags(config({ featureCrm: false, featureIms: false }))).toEqual({
      featureCrm: false,
      featureIms: false,
      featureBureauSubmission: false,
    })
  })

  it("resolves featureBureauSubmission from its own column only", () => {
    expect(resolveFeatureFlags(config({ featureBureauSubmission: true })).featureBureauSubmission).toBe(true)
    expect(resolveFeatureFlags(config({ featureCrm: true, featureIms: true })).featureBureauSubmission).toBe(false)
  })

  it("resolves each flag independently", () => {
    expect(resolveFeatureFlags(config({ featureCrm: true, featureIms: false }))).toEqual({
      featureCrm: true,
      featureIms: false,
      featureBureauSubmission: false,
    })
  })
})

describe("getTenantFeatures", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    headersGet.mockReturnValue("acme")
    findUniqueTenant.mockResolvedValue({ id: "tenant-1", slug: "acme" })
  })

  it("no TenantConfig row (tenant exists) resolves both flags OFF", async () => {
    findUniqueTenantConfig.mockResolvedValue(null)
    await expect(getTenantFeatures()).resolves.toEqual({ featureCrm: false, featureIms: false, featureBureauSubmission: false })
  })

  it("a row with flags set passes them through", async () => {
    findUniqueTenantConfig.mockResolvedValue(config({ featureCrm: true, featureIms: true }))
    await expect(getTenantFeatures()).resolves.toEqual({ featureCrm: true, featureIms: true, featureBureauSubmission: false })
  })

  it("tenant lookup miss (unknown slug) resolves both flags OFF without querying config", async () => {
    findUniqueTenant.mockResolvedValue(null)
    await expect(getTenantFeatures()).resolves.toEqual({ featureCrm: false, featureIms: false, featureBureauSubmission: false })
    expect(findUniqueTenantConfig).not.toHaveBeenCalled()
  })

  it("a thrown error (e.g. headers()/DB failure) resolves both flags OFF (fail closed)", async () => {
    findUniqueTenant.mockRejectedValue(new Error("db unreachable"))
    await expect(getTenantFeatures()).resolves.toEqual({ featureCrm: false, featureIms: false, featureBureauSubmission: false })
  })
})

describe("getResolvedTenantId precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    headersGet.mockReturnValue(null)
    findFirstTenant.mockResolvedValue(null)
    process.env.NEXT_PUBLIC_TENANT_SLUG = "acme"
  })

  function tenantsBySlug(map: Record<string, { id: string; status: string } | null>) {
    findUniqueTenant.mockImplementation(async (args: { where: { slug: string } }) =>
      map[args.where.slug] ?? null,
    )
  }

  // proxy.ts derives this header from the HOST and strips any inbound copy, so
  // it is the edge's answer. Ignoring it meant a page resolved via the
  // build-baked env slug while its API resolved via the host.
  it("resolves the proxy-set x-tenant-slug over the build-baked env slug", async () => {
    headersGet.mockImplementation((n: string) => (n === "x-tenant-slug" ? "tenant-b" : null))
    tenantsBySlug({
      "tenant-b": { id: "id-b", status: "ACTIVE" },
      acme: { id: "id-default", status: "ACTIVE" },
    })
    await expect(getResolvedTenantId()).resolves.toBe("id-b")
  })

  // Substituting the DEFAULT tenant here is the cross-tenant swap this function
  // exists to prevent: a suspended tenant's staff would be shown, and could
  // write to, the default tenant's data. A slug that named no ACTIVE tenant is
  // a resolution FAILURE, not an absent one.
  it("refuses to substitute the default tenant when the header names a non-ACTIVE tenant", async () => {
    headersGet.mockImplementation((n: string) => (n === "x-tenant-slug" ? "susp" : null))
    tenantsBySlug({ susp: { id: "id-susp", status: "SUSPENDED" }, acme: { id: "id-default", status: "ACTIVE" } })
    await expect(getResolvedTenantId()).rejects.toThrow(/not an ACTIVE tenant/)
  })

  it("refuses to substitute the default tenant when the header names no tenant at all", async () => {
    headersGet.mockImplementation((n: string) => (n === "x-tenant-slug" ? "ghost" : null))
    tenantsBySlug({ ghost: null, acme: { id: "id-default", status: "ACTIVE" } })
    await expect(getResolvedTenantId()).rejects.toThrow(/not an ACTIVE tenant/)
  })

  // getTenantFromRequest resolves Tenant.domain FIRST. Skipping it here left a
  // domain-mapped tenant invisible to pages while the API resolved it fine.
  it("resolves a custom domain, as the request-side resolver does", async () => {
    headersGet.mockImplementation((n: string) => (n === "host" ? "loans.acme.co.za" : null))
    findFirstTenant.mockResolvedValue({ id: "id-acme" })
    await expect(getResolvedTenantId()).resolves.toBe("id-acme")
    expect(findFirstTenant).toHaveBeenCalledWith(expect.objectContaining({
      where: { domain: "loans.acme.co.za", status: "ACTIVE" },
    }))
  })

  // Must assert the QUERY, not the resolved id: the mock returns id-acme for
  // any where clause, so without this the port could stop being stripped and
  // the test would still pass.
  it("matches a custom domain without its port", async () => {
    headersGet.mockImplementation((n: string) => (n === "host" ? "loans.acme.co.za:3000" : null))
    findFirstTenant.mockResolvedValue({ id: "id-acme" })
    await expect(getResolvedTenantId()).resolves.toBe("id-acme")
    expect(findFirstTenant).toHaveBeenCalledWith(expect.objectContaining({
      where: { domain: "loans.acme.co.za", status: "ACTIVE" },
    }))
  })

  it("prefers the domain over the header when both resolve", async () => {
    headersGet.mockImplementation((n: string) =>
      n === "host" ? "loans.acme.co.za" : n === "x-tenant-slug" ? "tenant-b" : null)
    findFirstTenant.mockResolvedValue({ id: "id-acme" })
    tenantsBySlug({ "tenant-b": { id: "id-b", status: "ACTIVE" } })
    await expect(getResolvedTenantId()).resolves.toBe("id-acme")
  })

  it("falls back to the env default when no header is present", async () => {
    tenantsBySlug({ acme: { id: "id-default", status: "ACTIVE" } })
    await expect(getResolvedTenantId()).resolves.toBe("id-default")
  })

  it("falls back to the env default when there is no request scope", async () => {
    headersGet.mockImplementation(() => { throw new Error("no request scope") })
    tenantsBySlug({ acme: { id: "id-default", status: "ACTIVE" } })
    await expect(getResolvedTenantId()).resolves.toBe("id-default")
  })

  // A DB failure resolving the named tenant must NOT degrade to "serve the
  // default tenant" — that is one tenant's data shown to another, silently.
  it("propagates a lookup failure instead of falling back to the default tenant", async () => {
    headersGet.mockImplementation((n: string) => (n === "x-tenant-slug" ? "tenant-b" : null))
    // Reject ONLY the header slug's lookup; the default slug must still
    // resolve. A blanket reject would make this test pass even if the failure
    // were swallowed, because the fallback would throw on its own.
    findUniqueTenant.mockImplementation(async (args: { where: { slug: string } }) => {
      if (args.where.slug === "tenant-b") throw new Error("db unreachable")
      return { id: "id-default", status: "ACTIVE" }
    })
    await expect(getResolvedTenantId()).rejects.toThrow(/db unreachable/)
  })
})

describe("getResolvedTenantId host normalisation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    headersGet.mockReturnValue(null)
    findFirstTenant.mockResolvedValue(null)
    process.env.NEXT_PUBLIC_TENANT_SLUG = "acme"
    findUniqueTenant.mockResolvedValue({ id: "id-default", status: "ACTIVE" })
  })

  it("looks up a custom domain lowercased and without a trailing dot", async () => {
    headersGet.mockImplementation((n: string) => (n === "host" ? "Loans.ACME.co.za.:3000" : null))
    findFirstTenant.mockResolvedValue({ id: "id-acme" })
    await expect(getResolvedTenantId()).resolves.toBe("id-acme")
    expect(findFirstTenant).toHaveBeenCalledWith(expect.objectContaining({
      where: { domain: "loans.acme.co.za", status: "ACTIVE" },
    }))
  })

  // Mirrors getTenantFromRequest, which skips its domain step for loopback.
  it("issues no domain query for a loopback host", async () => {
    headersGet.mockImplementation((n: string) =>
      n === "host" ? "localhost:3000" : n === "x-tenant-slug" ? "acme" : null)
    await expect(getResolvedTenantId()).resolves.toBe("id-default")
    expect(findFirstTenant).not.toHaveBeenCalled()
  })
})
