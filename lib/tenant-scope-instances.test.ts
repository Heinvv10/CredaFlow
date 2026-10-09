import { describe, expect, it, vi } from "vitest"

// In development lib/prisma.ts keeps ONE Prisma client on globalThis across
// every bundle that imports it, while each bundle can get its own instance of
// lib/tenant-scope.ts. The client's tenant-scope extension reads the context
// of the instance that BUILT it, so a route that ran runWithTenant() from a
// second instance was refused with "missing-context" (seen on POST
// /api/website/apply once the website layout read the DB first). Every
// instance must therefore share one context.
describe("tenant scope context", () => {
  it("is shared by separately loaded instances of the module", async () => {
    const first = await import("./tenant-scope")
    vi.resetModules()
    const second = await import("./tenant-scope")
    expect(second).not.toBe(first)
    await second.runWithTenant("tenant-a", async () => {
      expect(first.getCurrentTenantId()).toBe("tenant-a")
    })
    await first.withoutTenantScope(async () => {
      expect(second.isAdminScope()).toBe(true)
    })
  })
})
