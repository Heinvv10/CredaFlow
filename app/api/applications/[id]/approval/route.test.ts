import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const progress = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "u1@x.invalid", role: "CREDIT_OFFICER" } })) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/approval/progress", () => ({ loadApprovalProgress: progress }))

import { GET } from "./route"

describe("GET /api/applications/[id]/approval", () => {
  it("answers where the application is in its chain, for the caller", async () => {
    progress.mockResolvedValue({ applies: true, requiredLevels: 2 })
    const res = await GET(new NextRequest("http://x/api/applications/a1/approval"), { params: Promise.resolve({ id: "a1" }) })
    expect(await res.json()).toEqual({ applies: true, requiredLevels: 2 })
    expect(progress).toHaveBeenCalledWith({ tenantId: "t1", applicationId: "a1", viewer: expect.objectContaining({ id: "u1", role: "CREDIT_OFFICER" }) })
  })
})
