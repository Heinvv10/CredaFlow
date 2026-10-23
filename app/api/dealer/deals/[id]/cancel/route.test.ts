import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The cancel route's own contract: the reason is checked before the library
// runs, and a refusal keeps its status (404 another dealer's or a colleague's
// draft, 409 with the lender). Who reaches it: app/api/dealer/dealer-route-guards.test.ts.
const h = vi.hoisted(() => ({ cancel: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: DEALER }) }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => ({ featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }) } } }))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => ({ id: "tenant-1" }),
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/dealer/cancel", () => ({ cancelDealerDraft: h.cancel }))

import { POST } from "./route"

const DEALER = { id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }
const post = (body: unknown) => POST(new NextRequest("https://dealers.lender.example/api/dealer/deals/deal-1/cancel", {
  method: "POST", body: JSON.stringify(body), headers: { host: "dealers.lender.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
}), { params: Promise.resolve({ id: "deal-1" }) })

beforeEach(() => h.cancel.mockReset())

describe("POST /api/dealer/deals/[id]/cancel", () => {
  it("refuses a reason under 10 characters without cancelling", async () => {
    const res = await post({ reason: "  too short " })
    expect(res.status).toBe(400)
    expect(h.cancel).not.toHaveBeenCalled()
  })

  it("cancels with the trimmed reason as the signed-in dealer user", async () => {
    h.cancel.mockResolvedValue({ kind: "cancelled" })
    const res = await post({ reason: "  The buyer chose another machine  " })
    expect(res.status).toBe(200)
    expect(h.cancel).toHaveBeenCalledWith(expect.objectContaining({ dealerUserId: "du-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" }),
      "deal-1", "The buyer chose another machine")
  })

  it.each([404, 409] as const)("answers the library's %i refusal as given", async (status) => {
    h.cancel.mockResolvedValue({ kind: "refused", status, error: "refused" })
    const res = await post({ reason: "The buyer chose another machine" })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: "refused" })
  })
})
