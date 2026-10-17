import { NextRequest } from "next/server"
import { beforeEach, expect, it, vi } from "vitest"
const { end, action } = vi.hoisted(() => ({ end: vi.fn(), action: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-end-of-term", () => ({ endExtension: end, electEndOfTerm: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-term-end", () => ({ bestMarketValuation: vi.fn() }))
vi.mock("@/lib/asset-finance/lease-route", () => ({
  badRequest: vi.fn(), leasePortalAction: action,
}))
import { POST } from "./route"
beforeEach(() => { vi.clearAllMocks() })
it("uses the server receipt date when a consumer tries to backdate continuation notice", async () => {
  const actor = { tenantId: "synthetic-tenant", clientId: "synthetic-client" }
  const tx = { synthetic: true }
  action.mockImplementation(async (_req, _loanId, _name, run) => run(tx, actor, "2026-10-17", { action: "extension-notice", noticeOn: "2026-08-01" }))
  await POST(new NextRequest("http://localhost/api/portal/asset-finance/leases/synthetic-loan/end-of-term", { method: "POST" }), { params: Promise.resolve({ loanId: "synthetic-loan" }) })
  expect(end).toHaveBeenCalledWith(tx, actor, { loanId: "synthetic-loan", noticeOn: "2026-10-17", today: "2026-10-17" })
})
