import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The real limiter (memory store): the STK route's budget is five pushes per
// borrower and address in ten minutes; the sixth is refused.
const { auth, startStkPush } = vi.hoisted(() => ({ auth: vi.fn(), startStkPush: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    loan: { findFirst: vi.fn(async () => ({ id: "l1", reference: "NRB-LN-1", status: "ACTIVE", repaymentSchedule: [] })) },
  },
}))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_r: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/mobile-money/stk-push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-money/stk-push")>()),
  startStkPush,
}))
vi.mock("@/lib/loan/charge-aware-receipt", () => ({ loadReceiptReplay: vi.fn(async () => null), projectReceiptWithReplay: vi.fn() }))

import { POST } from "./route"

const push = (ip: string) => POST(new Request("http://localhost/api/portal/payment/mpesa", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
  body: JSON.stringify({ loanId: "l1", amount: 100, phone: "0712 345 678" }),
}))

beforeEach(() => {
  vi.stubEnv("RATE_LIMIT_STORE", "memory")
  vi.stubEnv("TRUSTED_PROXY", "1")
  vi.stubEnv("MPESA_PAYBILL_SHORTCODE", "600100")
  startStkPush.mockResolvedValue({ ok: true, transactionId: "mm1", status: "PENDING" })
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

describe("POST /api/portal/payment/mpesa rate limit", () => {
  it("allows five pushes per borrower and address in the window and refuses the sixth", async () => {
    auth.mockResolvedValue({ user: { email: `rl-${Date.now()}@test.invalid` } })
    for (let i = 1; i <= 5; i++) expect((await push("198.51.100.20")).status, `push ${i}`).toBe(200)
    const sixth = await push("198.51.100.20")
    expect(sixth.status).toBe(429)
    expect(Number(sixth.headers.get("Retry-After"))).toBeGreaterThan(0)
    expect(startStkPush).toHaveBeenCalledTimes(5)
    // The budget is per borrower AND address: the same borrower elsewhere has their own.
    expect((await push("198.51.100.21")).status).toBe(200)
  })
})
