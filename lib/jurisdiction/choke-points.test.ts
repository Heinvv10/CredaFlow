import { beforeEach, describe, expect, it, vi } from "vitest"

const ensure = vi.fn(async () => ({ jurisdiction: "ZA", currency: "ZAR" }))
vi.mock("./load.server", () => ({ ensureActiveJurisdiction: () => ensure() }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) } } }))
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }))
vi.mock("@/lib/auth-session", () => ({ getSession: vi.fn(async () => ({ user: { role: "ADMIN", tenantId: "t1" } })) }))
vi.mock("@/lib/auth-guards", () => ({ redirectStaleSession: vi.fn() }))

import { withTenantContext, getDefaultTenantId } from "@/lib/tenant"
import { getPortalTenantId, getStaffTenantId } from "@/lib/session-tenant"

beforeEach(() => ensure.mockClear())

// Every place that resolves a tenant first learns the lender's jurisdiction.
describe("jurisdiction is loaded before a tenant is resolved", () => {
  it("API routes (withTenantContext)", async () => {
    await withTenantContext(new Request("http://localhost/api/x"), async () => "unreached")
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it("staff pages and actions (getStaffTenantId)", async () => {
    await expect(getStaffTenantId()).resolves.toBe("t1")
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it("portal pages (getPortalTenantId)", async () => {
    await expect(getPortalTenantId()).rejects.toThrow()
    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it("background jobs (getDefaultTenantId)", async () => {
    await expect(getDefaultTenantId()).rejects.toThrow(/NEXT_PUBLIC_TENANT_SLUG/)
    expect(ensure).toHaveBeenCalledTimes(1)
  })
})
