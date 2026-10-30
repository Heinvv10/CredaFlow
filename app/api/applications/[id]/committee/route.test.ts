import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock("@/lib/auth-guards", async () => {
  const { canDo } = await import("@/lib/permissions")
  return { canDo, requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "u1@x.invalid", role: "ADMIN" } })) }
})
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/approval/committee", async () => {
  class CommitteeError extends Error { constructor(readonly code: string, readonly status: number, message: string, readonly problems: string[] = []) { super(message) } }
  return { CommitteeError, recordCommitteeDecision: h.record }
})

import { CommitteeError } from "@/lib/approval/committee"
import { POST } from "./route"

const good = { decision: "APPROVED", meetingDate: "2026-11-05", attendees: ["A. Dlamini"], conditions: ["Obtain the employer letter"], rationale: "Clean record and strong affordability" }
const call = (b: unknown) => POST(new NextRequest("http://x/api/applications/a1/committee", { method: "POST", body: JSON.stringify(b) }), { params: Promise.resolve({ id: "a1" }) })

beforeEach(() => { h.record.mockReset().mockResolvedValue({ id: "cd1" }) })

describe("POST /api/applications/[id]/committee", () => {
  it("records the decision for the application as the caller", async () => {
    const res = await call(good)
    expect(res.status).toBe(201)
    expect(h.record).toHaveBeenCalledWith({ tenantId: "t1", actor: expect.objectContaining({ id: "u1" }), applicationId: "a1", decision: { decision: "APPROVED", meetingDate: "2026-11-05", attendees: ["A. Dlamini"], conditions: ["Obtain the employer letter"], rationale: "Clean record and strong affordability" } })
  })
  it("conditions default to none", async () => {
    await call({ ...good, decision: "DEFERRED", conditions: undefined })
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ decision: expect.objectContaining({ conditions: [] }) }))
  })
  it.each([["an unknown decision", { ...good, decision: "MAYBE" }], ["attendees that are not a list", { ...good, attendees: "A. Dlamini" }], ["no rationale", { ...good, rationale: undefined }]])("answers 400 for %s", async (_n, b) => {
    expect((await call(b)).status).toBe(400)
    expect(h.record).not.toHaveBeenCalled()
  })
  it("answers with the refusal's status and its problems", async () => {
    h.record.mockRejectedValue(new CommitteeError("NOT_AT_COMMITTEE", 409, "The committee decides at level 3."))
    const res = await call(good)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "NOT_AT_COMMITTEE" })
  })
})
