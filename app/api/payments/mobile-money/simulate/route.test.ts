import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, ingest, logAuditStrict } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  ingest: vi.fn(),
  logAuditStrict: vi.fn(),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole,
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_r: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/mobile-money/c2b-ingest", () => ({ ingestMobileMoneyCallback: ingest }))
vi.mock("@/lib/audit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit")>()), logAuditStrict }))

import { POST } from "./route"
import { MAX_AMOUNT_CENTS } from "@/lib/mobile-money/types"

const post = (body: unknown) => POST(new NextRequest("http://x/api/payments/mobile-money/simulate", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "sim-secret")
  vi.stubEnv("DEMO_MODE", "true")
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "agent@test.invalid", role: "COLLECTIONS_AGENT" } })
  ingest.mockResolvedValue({ outcome: "BOOKED", transactionId: "mm1", paymentId: "p1" })
})
afterEach(() => { vi.unstubAllEnvs() })

describe("POST /api/payments/mobile-money/simulate", () => {
  it("does not exist where simulated-mpesa is not permitted (404, before any auth)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status).toBe(404)
    expect(requireApiRole).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it("does not exist outside a demo stack, even where simulated-mpesa is permitted (a staging box with real loans)", async () => {
    for (const demo of ["", "false", "TRUE"]) {
      vi.stubEnv("DEMO_MODE", demo)
      expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status, demo).toBe(404)
    }
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("SIMULATED_INTEGRATIONS", "simulated-mpesa")
    vi.stubEnv("DEMO_MODE", "")
    expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status).toBe(404)
    expect(requireApiRole).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it("delivers a signed paybill payment for this lender through the real ingest, audited", async () => {
    const res = await post({ loanReference: "NRB-LN-1", amount: 500 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ outcome: "BOOKED" })
    expect(ingest.mock.calls[0][1]).toMatchObject({
      tenantId: "t1", provider: expect.objectContaining({ id: "simulated" }),
      callback: { kind: "C2B", billRef: "NRB-LN-1", amountCents: 50_000 },
    })
    expect(logAuditStrict.mock.calls[0][0]).toMatchObject({ tenantId: "t1", userId: "u1", action: "MOBILE_MONEY_PAYBILL_SIMULATED" })
  })

  it("answers the session guard's refusal unchanged", async () => {
    requireApiRole.mockResolvedValue({ error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) })
    expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status).toBe(401)
    expect(ingest).not.toHaveBeenCalled()
  })

  it("refuses an amount a cents column cannot hold, and accepts the largest one it can", async () => {
    const largest = Math.floor(MAX_AMOUNT_CENTS / 100)
    expect((await post({ loanReference: "NRB-LN-1", amount: largest + 1 })).status).toBe(400)
    expect(ingest).not.toHaveBeenCalled()
    expect((await post({ loanReference: "NRB-LN-1", amount: largest })).status).toBe(200)
  })

  it("refuses a role that cannot record payments, a bad body and an unsigned environment", async () => {
    expect((await post("{nope")).status).toBe(400)
    expect((await post({ loanReference: "NRB-LN-1", amount: 12.5 })).status).toBe(400)
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "")
    expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status).toBe(503)
    requireApiRole.mockResolvedValue({ user: { id: "u2", email: "i@test.invalid", role: "INSURANCE_OFFICER" } })
    expect((await post({ loanReference: "NRB-LN-1", amount: 500 })).status).toBe(403)
    expect(ingest).not.toHaveBeenCalled()
  })
})
