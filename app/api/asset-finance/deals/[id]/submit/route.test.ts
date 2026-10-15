import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ submitDeal: vi.fn(), screenOnSubmit: vi.fn(), requireApiRole: vi.fn() }))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => h.requireApiRole(), canDo: () => true }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: async () => null }))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async () => ({ id: "deal-1" }) }))
vi.mock("@/lib/asset-finance/deal-submit", () => ({ submitDeal: (...a: unknown[]) => h.submitDeal(...a) }))
vi.mock("@/lib/screening/on-submit", () => ({ screenOnSubmit: (a: unknown) => h.screenOnSubmit(a) }))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (cb: (tx: unknown) => Promise<unknown>) => cb({}) } }))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "deal-1" }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u@test.invalid", role: "CREDIT_OFFICER", tenantId: "t1" } })
})

describe("POST /api/asset-finance/deals/[id]/submit — screening (REPRO 6 / M3)", () => {
  it("screens the deal's borrower once the submission has committed", async () => {
    h.submitDeal.mockResolvedValue({ kind: "submitted", awaitingRegimeApproval: false, regime: "NCA", rule: "NATURAL_PERSON_NCA" })
    expect((await POST(new NextRequest("http://x", { method: "POST" }), ctx)).status).toBe(200)
    expect(h.screenOnSubmit).toHaveBeenCalledWith({ tenantId: "t1", dealId: "deal-1", actor: { id: "u1", email: "u@test.invalid" } })
  })

  it("does not screen a deal that was not submitted", async () => {
    h.submitDeal.mockResolvedValue({ kind: "not_draft", status: "SUBMITTED" })
    await POST(new NextRequest("http://x", { method: "POST" }), ctx)
    expect(h.screenOnSubmit).not.toHaveBeenCalled()
  })
})
