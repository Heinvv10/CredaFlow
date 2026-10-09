import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { auth, findFirstClient, findFirstLoan, createStitchPayment, createStitchRequest } = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirstClient: vi.fn(),
  findFirstLoan: vi.fn(),
  createStitchPayment: vi.fn(),
  createStitchRequest: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: findFirstClient },
    loan: { findFirst: findFirstLoan },
    stitchPaymentRequest: { create: createStitchRequest },
  },
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/stitch", () => ({ createStitchPayment }))
const { loadChargesReplay } = vi.hoisted(() => ({ loadChargesReplay: vi.fn() }))
vi.mock("@/lib/loan/charges-replay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-replay")>()),
  loadChargesReplay,
}))

function makeReq(body: unknown) {
  return new Request("http://localhost/api/portal/payment/initiate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => { process.env.NEXTAUTH_URL = "https://portal.example.com" })
afterEach(() => { vi.clearAllMocks(); delete process.env.NEXTAUTH_URL })

describe("POST /api/portal/payment/initiate", () => {
  it("returns 401 when not signed in", async () => {
    auth.mockResolvedValue(null)
    const { POST } = await import("./route")
    const res = await POST(makeReq({ loanId: "l1", amount: 100 }))
    expect(res.status).toBe(401)
  })

  // PORT-01: the Stitch browser return URL must hit the callback ROUTE HANDLER at
  // /api/portal/payment/callback (which records the status + bounces to the
  // success/failure page), NOT the /api-less /portal/payment/callback, which has
  // no page/route and 404s the payer after they pay.
  it("sends Stitch a redirectUrl targeting the /api callback handler", async () => {
    process.env.NEXTAUTH_URL = "https://portal.example.com"
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1" })
    findFirstLoan.mockResolvedValue({
      id: "l1",
      reference: "LN-0005",
      status: "ACTIVE",
      principal: 20_000,
      totalInterest: 1_000,
      totalRepayable: 30_000,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
      totalPaid: 0,
      interestRatePm: 0.05,
      interestModel: "FLAT",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      maturityDate: new Date("2026-07-31T00:00:00.000Z"),
      repaymentSchedule: [{
        id: "row1",
        principalDue: 20_000,
        interestDue: 1_000,
        serviceFeeDue: 6_900,
        initiationFeeDue: 2_100,
        totalDue: 30_000,
        totalPaid: 0,
        dueDate: new Date("2026-07-31T00:00:00.000Z"),
      }],
    })
    createStitchPayment.mockResolvedValue({ id: "stitch1", url: "https://stitch.example/pay/stitch1" })
    createStitchRequest.mockResolvedValue({ id: "req1" })

    const { POST } = await import("./route")
    const res = await POST(makeReq({ loanId: "loan-12345678", amount: 250 }))
    expect(res.status).toBe(200)

    const expectedRedirect = "https://portal.example.com/api/portal/payment/callback"
    // The URL handed to Stitch must point at the /api callback handler.
    expect(createStitchPayment).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUrl: expectedRedirect }),
    )
    // …and the persisted request must carry the same corrected URL.
    expect(createStitchRequest).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ redirectUrl: expectedRedirect }) }),
    )
  })

  it("rejects unearned day-30 interest above the current day-15 settlement", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"))
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1" })
    findFirstLoan.mockResolvedValue({
      id: "l1",
      reference: "LN-0005",
      status: "ACTIVE",
      principal: 200_000,
      totalInterest: 10_000,
      totalRepayable: 246_900,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
      totalPaid: 0,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
      startDate: new Date("2026-07-01T08:00:00.000Z"),
      maturityDate: new Date("2026-07-31T08:00:00.000Z"),
      repaymentSchedule: [{
        id: "row1",
        principalDue: 200_000,
        interestDue: 10_000,
        serviceFeeDue: 6_900,
        initiationFeeDue: 30_000,
        totalDue: 246_900,
        totalPaid: 0,
        dueDate: new Date("2026-07-31T08:00:00.000Z"),
      }],
    })

    let response
    try {
      const { POST } = await import("./route")
      response = await POST(makeReq({
        loanId: "loan-12345678",
        amount: 2_469,
      }))
    } finally {
      vi.useRealTimers()
    }

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Payment exceeds the current settlement amount.",
      maxAmountCents: 241_900,
    })
    expect(createStitchPayment).not.toHaveBeenCalled()
    expect(createStitchRequest).not.toHaveBeenCalled()
  })

  it("bounds a Stitch payment by the charge-inclusive settlement once default charges are live", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1" })
    // The replay: R80 of default interest first, then the R300 schedule; beyond
    // R380 nothing is owed.
    loadChargesReplay.mockResolvedValue({
      replayAt: (_at: Date, extra: Array<{ id: string; amount: number }>) => {
        const amount = extra[0].amount
        const toDefaultInterest = Math.min(amount, 8_000)
        const toSchedule = Math.min(amount - toDefaultInterest, 30_000)
        return {
          interestAccrued: 8_000, feesAccrued: 0,
          unallocated: amount - toDefaultInterest - toSchedule,
          receiptSplits: [{ receiptId: extra[0].id, toDefaultInterest, toFees: 0, toSchedule }],
        }
      },
    })
    findFirstLoan.mockResolvedValue({
      id: "l1", reference: "LN-0005", status: "ACTIVE", tenantId: "t1",
      principal: 20_000, totalInterest: 1_000, totalRepayable: 30_000,
      contractualTotalInterest: null, contractualTotalRepayable: null, totalPaid: 0,
      interestRatePm: 0.05, interestModel: "FLAT",
      startDate: new Date("2026-07-01T00:00:00.000Z"), maturityDate: new Date("2026-07-31T00:00:00.000Z"),
      tenant: { config: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-07-01T00:00:00.000Z") } },
      repaymentSchedule: [{
        id: "row1", principalDue: 20_000, interestDue: 1_000, feesDue: 9_000,
        totalDue: 30_000, totalPaid: 0, dueDate: new Date("2026-07-31T00:00:00.000Z"),
      }],
    })
    createStitchPayment.mockResolvedValue({ id: "stitch1", url: "https://stitch.example/pay/stitch1" })
    createStitchRequest.mockResolvedValue({ id: "req1" })

    const { POST } = await import("./route")
    // R380 = R300 schedule + R80 charges: allowed. One cent more is not.
    expect((await POST(makeReq({ loanId: "l1", amount: 380 }))).status).toBe(200)
    const over = await POST(makeReq({ loanId: "l1", amount: 380.01 }))
    expect(over.status).toBe(422)
    expect(await over.json()).toMatchObject({ maxAmountCents: 38_000 })
  })

  it("lets a client in default pay, and still refuses a closed loan", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1" })
    loadChargesReplay.mockResolvedValue(null)
    createStitchPayment.mockResolvedValue({ id: "stitch1", url: "https://stitch.example/pay/stitch1" })
    createStitchRequest.mockResolvedValue({ id: "req1" })
    const loan = (status: string) => ({
      id: "l1", reference: "LN-0005", status, tenantId: "t1", principal: 20_000, totalInterest: 1_000,
      totalRepayable: 30_000, contractualTotalInterest: null, contractualTotalRepayable: null, totalPaid: 0,
      interestRatePm: 0.05, interestModel: "FLAT", startDate: new Date("2026-07-01T00:00:00.000Z"),
      maturityDate: new Date("2026-07-31T00:00:00.000Z"), tenant: { config: null },
      repaymentSchedule: [{
        id: "row1", principalDue: 20_000, interestDue: 1_000, feesDue: 9_000, totalDue: 30_000, totalPaid: 0,
        dueDate: new Date("2026-07-31T00:00:00.000Z"),
      }],
    })
    const { POST } = await import("./route")
    findFirstLoan.mockResolvedValue(loan("DEFAULTED"))
    expect((await POST(makeReq({ loanId: "l1", amount: 250 }))).status).toBe(200)
    findFirstLoan.mockResolvedValue(loan("COMPLETED"))
    expect((await POST(makeReq({ loanId: "l1", amount: 250 }))).status).toBe(400)
  })
})
