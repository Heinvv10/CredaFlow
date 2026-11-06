import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { auth, findFirstClient, findFirstLoan, startStkPush, projectReceiptWithReplay } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirstClient: vi.fn(),
  findFirstLoan: vi.fn(),
  startStkPush: vi.fn(),
  projectReceiptWithReplay: vi.fn(),
}))
vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: findFirstClient }, loan: { findFirst: findFirstLoan } } }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/mobile-money/stk-push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-money/stk-push")>()),
  startStkPush,
}))
vi.mock("@/lib/loan/charge-aware-receipt", () => ({ loadReceiptReplay: vi.fn(async () => null), projectReceiptWithReplay }))

import { POST } from "./route"
import { SettlementOverpaymentError } from "@/lib/loan/settlement"
import { MobileMoneyProviderError } from "@/lib/mobile-money/types"

const req = (body: unknown) => new Request("http://localhost/api/portal/payment/mpesa", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
})
const body = { loanId: "l1", amount: 1200, phone: "0712 345 678" }

beforeEach(() => {
  vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "600100")
  vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", "s")
  auth.mockResolvedValue({ user: { email: "borrower@test.invalid" } })
  findFirstClient.mockResolvedValue({ id: "c1" })
  findFirstLoan.mockResolvedValue({ id: "l1", reference: "NRB-LN-1", status: "ACTIVE", repaymentSchedule: [] })
  startStkPush.mockResolvedValue({ ok: true, transactionId: "mm1", status: "BOOKED" })
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

describe("POST /api/portal/payment/mpesa", () => {
  it("returns 401 when not signed in", async () => {
    auth.mockResolvedValue(null)
    expect((await POST(req(body))).status).toBe(401)
  })

  it("returns 404 while the lender has no paybill configured", async () => {
    vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "")
    expect((await POST(req(body))).status).toBe(404)
    expect(startStkPush).not.toHaveBeenCalled()
  })

  it("refuses a fractional, zero or missing amount", async () => {
    for (const amount of [12.5, 0, -1, "100", undefined]) {
      expect((await POST(req({ ...body, amount }))).status, String(amount)).toBe(400)
    }
    expect(startStkPush).not.toHaveBeenCalled()
  })

  it("refuses a loan the borrower does not hold, or one that is not active", async () => {
    findFirstLoan.mockResolvedValueOnce(null)
    expect((await POST(req(body))).status).toBe(404)
    findFirstLoan.mockResolvedValueOnce({ id: "l1", reference: "NRB-LN-1", status: "COMPLETED", repaymentSchedule: [] })
    expect((await POST(req(body))).status).toBe(400)
  })

  it("refuses more than today's settlement", async () => {
    projectReceiptWithReplay.mockImplementationOnce(() => { throw new SettlementOverpaymentError(50_000) })
    const res = await POST(req(body))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ maxAmountCents: 50_000 })
  })

  it("pushes the whole-shilling amount for the borrower's own loan and reports the result", async () => {
    const res = await POST(req(body))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ transactionId: "mm1", status: "BOOKED" })
    expect(startStkPush.mock.calls[0][1]).toMatchObject({
      tenantId: "t1", loan: { id: "l1", reference: "NRB-LN-1" }, amountCents: 120_000, phone: "0712 345 678", actorEmail: "borrower@test.invalid",
    })
    expect(findFirstLoan.mock.calls[0][0].where).toMatchObject({ id: "l1", clientId: "c1", tenantId: "t1" })
  })

  it("answers 400 to a phone M-Pesa cannot prompt, and 503 where the provider may not run", async () => {
    startStkPush.mockResolvedValueOnce({ ok: false, reason: "INVALID_PHONE", message: "Enter a Kenyan mobile number" })
    expect((await POST(req(body))).status).toBe(400)
    startStkPush.mockRejectedValueOnce(new MobileMoneyProviderError("SIMULATION_FORBIDDEN", "not here"))
    expect((await POST(req(body))).status).toBe(503)
  })
})
