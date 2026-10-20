import { beforeEach, describe, expect, it, vi } from "vitest"

// requireDealerPage: the portal pages' guard. No session → the dealer sign-in;
// any other refusal of a signed-in session (staff, client, another lender's
// dealer, the portal off, DEALER_SALES on an admin page) → 404.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  hostTenantId: "tenant-1",
  config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } as Record<string, boolean> | null,
}))
class Redirect extends Error {}
class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Redirect(to) },
  notFound: () => { throw new NotFound("not found") },
}))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => h.config } } }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: async () => h.hostTenantId }))

import { requireDealerPage } from "./page-guard"

const DEALER = { id: "du-1", email: "sales@dealer.example", name: "Sales", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }

beforeEach(() => {
  h.session = { user: { ...DEALER } }
  h.hostTenantId = "tenant-1"
  h.config = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }
})

describe("requireDealerPage", () => {
  it("returns the dealer actor of the host's lender", async () => {
    await expect(requireDealerPage()).resolves.toEqual({
      tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.example", dealerRole: "DEALER_SALES", name: "Sales",
    })
  })

  it("sends a visitor with no session to the dealer sign-in", async () => {
    h.session = null
    await expect(requireDealerPage()).rejects.toThrow(new Redirect("/dealer/login"))
  })

  it.each([
    ["a staff session", () => { h.session = { user: { id: "u-1", email: "a@l.test", role: "SUPER_ADMIN", tenantId: "tenant-1" } } }],
    ["a client session", () => { h.session = { user: { id: "c-1", email: "c@l.test", role: "CLIENT", tenantId: "tenant-1" } } }],
    ["another lender's dealer", () => { h.hostTenantId = "tenant-2" }],
    ["the portal switched off", () => { h.config = { featureAssetFinance: true, featureDealerPortal: false, isDemoLender: true } }],
    ["a non-demo lender", () => { h.config = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: false } }],
  ])("renders 404 for %s", async (_label, arrange) => {
    arrange()
    await expect(requireDealerPage()).rejects.toBeInstanceOf(NotFound)
  })

  it("renders 404 for DEALER_SALES on an admin page, and serves DEALER_ADMIN", async () => {
    await expect(requireDealerPage({ admin: true })).rejects.toBeInstanceOf(NotFound)
    h.session = { user: { ...DEALER, dealerRole: "DEALER_ADMIN" } }
    await expect(requireDealerPage({ admin: true })).resolves.toMatchObject({ dealerRole: "DEALER_ADMIN" })
  })
})
