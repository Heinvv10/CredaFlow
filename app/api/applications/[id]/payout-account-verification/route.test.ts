import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ guard: vi.fn(), record: vi.fn() }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: h.guard }))
vi.mock("@/lib/non-nca-documents/payout-account", () => ({ recordPayoutAccountVerification: h.record }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => unknown) => fn({ id: "t1" }) }))

import { POST } from "./route"

const post = (body: string) => POST(new NextRequest("http://localhost/api/applications/a1/payout-account-verification", { method: "POST", body }), { params: Promise.resolve({ id: "a1" }) })

describe("POST payout-account-verification", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.guard.mockResolvedValue({ user: { id: "second", email: "second@test.invalid" } })
  })

  it("is a credit officer's action: below that the guard answers and nothing is recorded", async () => {
    h.guard.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await post(JSON.stringify({ note: "x" }))).status).toBe(403)
    expect(h.guard).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(h.record).not.toHaveBeenCalled()
  })

  it("records it for the signed-in staff member, on this tenant's application", async () => {
    h.record.mockResolvedValue({ ok: true, id: "check-1" })
    const res = await post(JSON.stringify({ note: "Confirmed with the bank." }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "check-1" })
    expect(h.record).toHaveBeenCalledWith({ tenantId: "t1", applicationId: "a1", user: { id: "second", email: "second@test.invalid" }, note: "Confirmed with the bank." })
  })

  it.each([400, 404, 409, 422])("answers a %i refusal with its status", async (status) => {
    h.record.mockResolvedValue({ ok: false, status, error: "No." })
    const res = await post(JSON.stringify({ note: "x" }))
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: "No." })
  })

  it("a body that is not JSON is a missing note, not a crash", async () => {
    h.record.mockResolvedValue({ ok: false, status: 400, error: "Say how." })
    expect((await post("not json")).status).toBe(400)
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ note: undefined }))
  })
})
