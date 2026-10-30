import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const overview = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth-guards", async () => {
  const { canDo } = await import("@/lib/permissions")
  return { canDo, requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "u1@x.invalid", role: "LOAN_ADMIN" } })) }
})
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/approval/overview", () => ({ loadApprovalMatrixOverview: overview }))

import { GET } from "./route"

describe("GET /api/approval/matrix", () => {
  it("answers the overview for the caller's tenant and viewer", async () => {
    overview.mockResolvedValue({ inForce: null, versions: [] })
    const res = await GET(new NextRequest("http://x/api/approval/matrix"))
    expect(await res.json()).toEqual({ inForce: null, versions: [] })
    expect(overview).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "u1", role: "LOAN_ADMIN" }))
  })
})
