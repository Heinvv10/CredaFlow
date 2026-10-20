import { beforeEach, describe, expect, it, vi } from "vitest"

// requireDealer / withDealer: the session, the host's lender and the portal
// flags are stubbed; the guard itself runs for real.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  hostTenant: { id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" } as Record<string, unknown> | null,
  config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } as Record<string, boolean> | null,
  scoped: [] as string[],
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => h.config } } }))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => h.hostTenant,
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => {
    h.scoped.push("tenant-1")
    return fn({ id: "tenant-1" })
  },
}))

import { requireDealer, withDealer } from "./guards"

const DEALER = { id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }
const req = () => new Request("https://dealers.lender.example/api/dealer/deals", { headers: { host: "dealers.lender.example" } })
const status = async (opts: { admin?: true } = {}) => {
  const result = await requireDealer(req(), opts)
  return result.error ? result.error.status : 200
}

beforeEach(() => {
  h.session = { user: { ...DEALER } }
  h.hostTenant = { id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }
  h.config = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }
  h.scoped = []
})

describe("requireDealer", () => {
  it("returns the dealer actor for a dealer session of the host's lender", async () => {
    await expect(requireDealer(req())).resolves.toEqual({
      actor: { tenantId: "tenant-1", dealerId: "dealer-1", dealerUserId: "du-1", email: "sales@dealer.example", dealerRole: "DEALER_SALES" },
    })
  })

  it("answers 401 with no session", async () => {
    h.session = null
    expect(await status()).toBe(401)
  })

  it.each([
    ["staff", { id: "u-1", email: "a@lender.test", role: "SUPER_ADMIN", tenantId: "tenant-1" }],
    ["client", { id: "c-1", email: "c@client.test", role: "CLIENT", tenantId: "tenant-1" }],
    ["operator", { id: "op-1", email: "o@op.test", role: "OPERATOR_ADMIN", tenantId: null, operatorId: "operator-1" }],
    ["a dealer token without its dealer", { ...DEALER, dealerId: null }],
  ])("answers 404 to a %s session", async (_label, user) => {
    h.session = { user }
    expect(await status()).toBe(404)
  })

  it("answers 404 to another lender's dealer, and on a host that resolves no lender", async () => {
    h.hostTenant = { id: "tenant-2", slug: "other", name: "Other", domain: null, status: "ACTIVE" }
    expect(await status()).toBe(404)
    h.hostTenant = null
    expect(await status()).toBe(404)
  })

  it.each([{ featureDealerPortal: false }, { featureAssetFinance: false }, { isDemoLender: false }])("answers 404 when %j", async (off) => {
    h.config = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true, ...off }
    expect(await status()).toBe(404)
    h.config = null
    expect(await status()).toBe(404)
  })

  it("lets only a DEALER_ADMIN through an admin route (404 otherwise)", async () => {
    expect(await status({ admin: true })).toBe(404)
    h.session = { user: { ...DEALER, dealerRole: "DEALER_ADMIN" } }
    expect(await status({ admin: true })).toBe(200)
  })
})

describe("withDealer", () => {
  it("runs the handler in the lender's tenant scope only when the guard passes", async () => {
    const handler = vi.fn(async () => new Response("ok"))
    expect((await withDealer(req(), {}, handler)).status).toBe(200)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ dealerId: "dealer-1" }))
    expect(h.scoped).toEqual(["tenant-1"])
    h.session = null
    expect((await withDealer(req(), {}, handler)).status).toBe(401)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
