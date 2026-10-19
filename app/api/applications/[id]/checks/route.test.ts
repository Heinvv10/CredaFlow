import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const requireApiRoleMock = vi.fn()
const recomputeMock = vi.fn()
const flagViewsMock = vi.fn()
const logAccessMock = vi.fn()
const enabledMock = vi.fn()
const explanationsMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/credit-checks/recompute", () => ({ recomputeApplicationFlags: (...a: unknown[]) => recomputeMock(...a) }))
vi.mock("@/lib/credit-checks/evidence", () => ({ flagViews: (...a: unknown[]) => flagViewsMock(...a) }))
vi.mock("@/lib/document-auth", () => ({ logDocumentContentAccess: (a: unknown) => logAccessMock(a) }))
vi.mock("@/lib/statement-ai/enabled", () => ({ statementAiEnabled: (...a: unknown[]) => enabledMock(...a) }))
vi.mock("@/lib/statement-ai/views", () => ({ flagExplanations: (...a: unknown[]) => explanationsMock(...a) }))
vi.mock("@/lib/statement-ai/worker", () => ({ enqueueApplication: vi.fn() }))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const get = () => GET(new NextRequest("https://acme.example/api/applications/app-1/checks"), ctx)

beforeEach(() => {
  vi.resetAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@test.invalid", role: "CREDIT_OFFICER", tenantId: "t1" } })
  recomputeMock.mockResolvedValue({ recomputed: true, flags: [{ id: "f1" }] })
  flagViewsMock.mockResolvedValue({
    flags: [{ id: "f1", status: "OPEN" }, { id: "f2", status: "CLEARED" }],
    documentIds: ["doc-1"],
  })
  logAccessMock.mockResolvedValue(undefined)
  enabledMock.mockResolvedValue(false)
  explanationsMock.mockResolvedValue(new Map([["f1", "Why f1 was raised."]]))
})

describe("GET /api/applications/[id]/checks", () => {
  it("recomputes as the caller and returns the flags with the open count", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recomputed: true, openCount: 1, flags: [{ id: "f1", status: "OPEN" }, { id: "f2", status: "CLEARED" }] })
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(recomputeMock).toHaveBeenCalledWith("t1", "app-1", { userId: "u1", email: "officer@test.invalid" })
  })

  it("logs access to every document whose rows it quotes", async () => {
    await get()
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ["doc-1"], staffUserId: "u1", action: "credit_check_evidence" }))
  })

  it("404s an application the tenant does not have", async () => {
    recomputeMock.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(logAccessMock).not.toHaveBeenCalled()
  })

  it.each(["cross-site", "same-site"])("refuses a %s request before it writes anything", async (site) => {
    const req = new NextRequest("https://acme.example/api/applications/app-1/checks", { headers: { "sec-fetch-site": site } })
    expect((await GET(req, ctx)).status).toBe(403)
    expect(requireApiRoleMock).not.toHaveBeenCalled()
    expect(recomputeMock).not.toHaveBeenCalled()
    const sameOrigin = new NextRequest("https://acme.example/api/applications/app-1/checks", { headers: { "sec-fetch-site": "same-origin" } })
    expect((await GET(sameOrigin, ctx)).status).toBe(200)
  })

  it("passes through a role refusal without recomputing", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(recomputeMock).not.toHaveBeenCalled()
  })

  it("Statement AI off: the flags exactly as before, no explanation read", async () => {
    expect(await (await get()).json()).toEqual({ recomputed: true, openCount: 1, flags: [{ id: "f1", status: "OPEN" }, { id: "f2", status: "CLEARED" }] })
    expect(enabledMock).toHaveBeenCalledWith("t1")
    expect(explanationsMock).not.toHaveBeenCalled()
  })

  it("Statement AI on: each flag with an explanation carries it in its own row, the others none", async () => {
    enabledMock.mockResolvedValue(true)
    const body = await (await get()).json()
    expect(body.flags).toEqual([{ id: "f1", status: "OPEN", explanation: "Why f1 was raised." }, { id: "f2", status: "CLEARED" }])
    expect(explanationsMock).toHaveBeenCalledWith("t1", "app-1")
  })

  // The explanation is advisory: a failure to write it must not take the flags (and Clear) away with it.
  it("Statement AI failing: the flags as before, logged, and the access still recorded", async () => {
    enabledMock.mockResolvedValue(true)
    explanationsMock.mockRejectedValue(new Error("statement load failed"))
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).flags).toEqual([{ id: "f1", status: "OPEN" }, { id: "f2", status: "CLEARED" }])
    expect(error).toHaveBeenCalledWith("[checks] flag explanations failed:", expect.any(Error))
    expect(logAccessMock).toHaveBeenCalled()
    error.mockRestore()
  })
})
