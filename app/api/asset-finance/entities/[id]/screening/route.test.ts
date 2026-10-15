import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({ requireApiRole: vi.fn(), entityFindFirst: vi.fn(), screenNow: vi.fn(), read: vi.fn() }))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: string) => h.requireApiRole(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: async () => null }))
vi.mock("@/lib/prisma", () => ({ prisma: { businessEntity: { findFirst: (a: unknown) => h.entityFindFirst(a) } } }))
vi.mock("@/lib/screening/subject-route", () => ({
  screenSubjectNow: (...a: unknown[]) => h.screenNow(...a),
  subjectScreeningResponse: (...a: unknown[]) => h.read(...a),
}))

import { GET, POST } from "./route"

const ctx = { params: Promise.resolve({ id: "entity-1" }) }
const req = (method = "GET") => new NextRequest("http://x", { method })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u@test.invalid", role: "CREDIT_OFFICER", tenantId: "t1" } })
  h.entityFindFirst.mockResolvedValue({ id: "entity-1" })
  h.screenNow.mockResolvedValue(NextResponse.json({ ok: true }))
  h.read.mockResolvedValue(NextResponse.json({ state: { state: "CLEAR" } }))
})

describe("/api/asset-finance/entities/[id]/screening", () => {
  it("screens this tenant's entity now, as the caller, with CREDIT_OFFICER as the floor", async () => {
    expect((await POST(req("POST"), ctx)).status).toBe(200)
    expect(h.requireApiRole).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(h.entityFindFirst).toHaveBeenCalledWith({ where: { id: "entity-1", tenantId: "t1" }, select: { id: true } })
    expect(h.screenNow).toHaveBeenCalledWith("t1", { entityId: "entity-1" }, { id: "u1", email: "u@test.invalid" })
  })

  it("reads the entity's screening state", async () => {
    await GET(req(), ctx)
    expect(h.read).toHaveBeenCalledWith("t1", { entityId: "entity-1" })
  })

  it("404s another tenant's entity without screening it", async () => {
    h.entityFindFirst.mockResolvedValue(null)
    expect((await POST(req("POST"), ctx)).status).toBe(404)
    expect(h.screenNow).not.toHaveBeenCalled()
  })

  it("refuses a caller below CREDIT_OFFICER", async () => {
    h.requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await POST(req("POST"), ctx)).status).toBe(403)
    expect(h.screenNow).not.toHaveBeenCalled()
  })
})
