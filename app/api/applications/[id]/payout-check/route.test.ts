import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ guard: vi.fn(), check: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: h.guard }))
vi.mock("@/lib/non-nca-documents/payout-gates", () => ({ keyFactsPayoutCheck: h.check }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => unknown) => fn({ id: "t1" }) }))

import { GET } from "./route"

const get = () => GET(new NextRequest("http://localhost/api/applications/a1/payout-check"), { params: Promise.resolve({ id: "a1" }) })

describe("GET payout-check", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.guard.mockResolvedValue({ user: { id: "u1", email: "u@test.invalid" } })
  })

  it("is for whoever may pay out", async () => {
    h.guard.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await get()).status).toBe(403)
    expect(h.guard).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(h.check).not.toHaveBeenCalled()
  })

  it("judges this person on this tenant's application", async () => {
    h.check.mockResolvedValue({ ok: true })
    expect(await (await get()).json()).toEqual({ ok: true })
    expect(h.check).toHaveBeenCalledWith({ tenantId: "t1", applicationId: "a1", user: { id: "u1", email: "u@test.invalid" } })
  })

  it("says why not", async () => {
    h.check.mockResolvedValue({ ok: false, status: 422, error: "Not yet.", precondition: "payout_account_verification" })
    expect(await (await get()).json()).toEqual({ ok: false, error: "Not yet.", disbursementPrecondition: "payout_account_verification" })
  })
})
