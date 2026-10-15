import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const resolveMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/collections-engine/review", () => ({ resolveReviewItem: (...a: unknown[]) => resolveMock(...a) }))

import { POST } from "./route"
import { MandateError } from "@/lib/collections-engine/mandates"

const call = (body: unknown) => POST(new NextRequest("http://localhost/api/collections-engine/review", { method: "POST", body: JSON.stringify(body) }))

describe("POST /api/collections-engine/review", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@example.test" } })
  })

  it("requires LOAN_ADMIN", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    expect((await call({})).status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: "MANDATE", id: "m1", action: "RELEASE", reason: "x" }],
    [{ kind: "RESULT", id: "r1", action: "RELEASE", reason: "x" }],
    [{ kind: "INSTRUCTION", id: "i1", action: "RELEASE", reason: " " }],
    [{ kind: "NOPE", id: "i1", action: "RELEASE", reason: "x" }],
  ])("refuses %o before the engine", async (body) => {
    expect((await call(body)).status).toBe(422)
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it("passes the staff actor, the item and the reason", async () => {
    resolveMock.mockResolvedValue(undefined)
    const response = await call({ kind: "INSTRUCTION", id: "i1", action: "RELEASE", reason: " provider never got it " })
    expect(response.status).toBe(200)
    expect(resolveMock).toHaveBeenCalledWith("tenant-1", { userId: "u1", userEmail: "admin@example.test" },
      { kind: "INSTRUCTION", id: "i1", action: "RELEASE", confirmedNotSent: false, paymentId: undefined, noMoneyReceived: false }, "provider never got it")
  })

  it("answers 409 when the item is not waiting for review", async () => {
    resolveMock.mockRejectedValue(new MandateError("INVALID_STATE", "Nothing to resolve"))
    expect((await call({ kind: "RESULT", id: "r1", action: "ACKNOWLEDGE", reason: "done" })).status).toBe(409)
  })
})
