import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ role: "LOAN_ADMIN", grant: vi.fn(), list: vi.fn(), revoke: vi.fn(), allowed: true }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: h.allowed })) }))
vi.mock("@/lib/auth-guards", async () => {
  const { canDo } = await import("@/lib/permissions")
  return {
    canDo,
    requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "u1@x.invalid", role: h.role } })),
  }
})
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/approval/delegations", async () => {
  class DelegationError extends Error { constructor(readonly code: string, readonly status: number, message: string, readonly problems: string[] = []) { super(message) } }
  return { DelegationError, grantDelegation: h.grant, listDelegations: h.list, revokeDelegation: h.revoke }
})

import { DelegationError } from "@/lib/approval/delegations"
import { DELETE } from "./[id]/route"
import { GET, POST } from "./route"

const body = { delegateId: "u2", level: 2, maxAmountCents: 500_000, validFrom: "2026-11-01T00:00:00Z", validTo: "2026-11-10T00:00:00Z", reason: "On leave for a week" }
const post = (b: unknown) => new NextRequest("http://x/api/approval/delegations", { method: "POST", body: JSON.stringify(b) })

beforeEach(() => { h.role = "LOAN_ADMIN"; h.allowed = true; h.grant.mockReset().mockResolvedValue({ id: "d1" }); h.list.mockReset().mockResolvedValue([]); h.revoke.mockReset().mockResolvedValue({}) })

describe("POST /api/approval/delegations", () => {
  it("records the delegation as the caller and answers 201", async () => {
    const res = await POST(post(body))
    expect(res.status).toBe(201)
    expect(h.grant).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", actor: expect.objectContaining({ id: "u1" }), delegation: expect.objectContaining({ delegateId: "u2", level: 2, maxAmountCents: 500_000, delegatorId: undefined }) }))
  })
  it("passes the delegator an administrator names, for the service to check", async () => {
    await POST(post({ ...body, delegatorId: "u9" }))
    expect(h.grant).toHaveBeenCalledWith(expect.objectContaining({ delegation: expect.objectContaining({ delegatorId: "u9" }) }))
  })
  it("answers 429 when the caller records too many, recording nothing", async () => {
    h.allowed = false
    expect((await POST(post(body))).status).toBe(429)
    expect(h.grant).not.toHaveBeenCalled()
  })
  it.each([["no delegate", { ...body, delegateId: undefined }], ["dates that are not dates", { ...body, validFrom: "someday" }], ["no reason", { ...body, reason: undefined }]])("answers 400 for %s, recording nothing", async (_n, b) => {
    expect((await POST(post(b))).status).toBe(400)
    expect(h.grant).not.toHaveBeenCalled()
  })
  it("turns a refusal into its status, with the problems", async () => {
    h.grant.mockRejectedValue(new DelegationError("INVALID", 422, "A delegation lasts at most 90 days.", ["A delegation lasts at most 90 days."]))
    const res = await POST(post(body))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: "INVALID", problems: ["A delegation lasts at most 90 days."] })
  })
})

describe("GET /api/approval/delegations", () => {
  it("lists them with the people's names", async () => {
    h.list.mockResolvedValue([{ id: "d1", delegatorId: "a", delegateId: "b", delegator: { name: "Ann", email: "a@x" }, delegate: { name: "", email: "b@x" }, level: 1, maxAmountCents: 1, validFrom: new Date("2026-11-01"), validTo: new Date("2026-11-02"), reason: "r", revokedAt: null, createdAt: new Date("2026-11-01") }])
    const res = await GET(new NextRequest("http://x/api/approval/delegations"))
    expect((await res.json()).delegations).toMatchObject([{ delegatorName: "Ann", delegateName: "b@x" }])
  })
})

describe("DELETE /api/approval/delegations/[id]", () => {
  const call = () => DELETE(new NextRequest("http://x/api/approval/delegations/d1", { method: "DELETE" }), { params: Promise.resolve({ id: "d1" }) })
  it("revokes", async () => {
    expect((await call()).status).toBe(200)
    expect(h.revoke).toHaveBeenCalledWith({ tenantId: "t1", actor: expect.objectContaining({ id: "u1" }), id: "d1" })
  })
  it("answers with the refusal's status", async () => {
    h.revoke.mockRejectedValue(new DelegationError("FORBIDDEN", 403, "Only the delegator can."))
    expect((await call()).status).toBe(403)
  })
})
