import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const createDebitMandateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/collections-engine/mandates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/collections-engine/mandates")>()),
  createDebitMandate: (...a: unknown[]) => createDebitMandateMock(...a),
}))

import { POST } from "./route"
import { MandateError } from "@/lib/collections-engine/mandates"

const call = (body: unknown) => POST(
  new NextRequest("http://localhost/api/loans/loan-1/collections-mandate", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "loan-1" }) },
)

describe("POST /api/loans/[id]/collections-mandate", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@example.test" } })
  })

  it("requires LOAN_ADMIN", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    expect((await call({})).status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(createDebitMandateMock).not.toHaveBeenCalled()
  })

  it("refuses a malformed body before the engine", async () => {
    expect((await call({ authType: "TT1", debitDay: "x", trackingDays: 3 })).status).toBe(422)
    expect(createDebitMandateMock).not.toHaveBeenCalled()
  })

  it("answers 409 while the engine is off for the lender", async () => {
    createDebitMandateMock.mockRejectedValue(new MandateError("FLAG_OFF", "The collections engine is off for this lender"))
    const response = await call({ authType: "TT1", debitDay: 25, trackingDays: 3 })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "FLAG_OFF" })
  })

  it("passes the staff actor and terms to the engine and answers 201", async () => {
    createDebitMandateMock.mockResolvedValue({ id: "m1", status: "PENDING_AUTH", statusReason: null })
    const response = await call({ authType: "TT2", debitDay: 25, trackingDays: 3, maxAmountCents: 120_000 })
    expect(response.status).toBe(201)
    expect(createDebitMandateMock).toHaveBeenCalledWith("tenant-1", { userId: "u1", userEmail: "admin@example.test" }, {
      loanId: "loan-1", authType: "TT2", debitDay: 25, trackingDays: 3, maxAmountCents: 120_000, adjustment: undefined,
    })
  })

  it("maps a scheme-limit refusal to 422", async () => {
    createDebitMandateMock.mockRejectedValue(new MandateError("INVALID_TERMS", "Tracking days must be 1–10"))
    expect((await call({ authType: "TT1", debitDay: 25, trackingDays: 11 })).status).toBe(422)
  })
})
