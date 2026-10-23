import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findUnique, scheduleFindUnique, sendEmail, charges } = vi.hoisted(() => ({
  findUnique: vi.fn(), scheduleFindUnique: vi.fn(), sendEmail: vi.fn(), charges: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { payment: { findUnique }, repaymentSchedule: { findUnique: scheduleFindUnique } },
}))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: charges }))
vi.mock("@/lib/email/service", () => ({ sendEmail }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => ({ id: "tenant-1", name: "Acme" }) }))
vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})

import { POST } from "./route"

const call = () => POST(new NextRequest("http://localhost/api/notifications/payment", {
  method: "POST",
  headers: { authorization: "Bearer internal-secret" },
  body: JSON.stringify({ paymentId: "pay-1", event: "received" }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_SECRET = "internal-secret"
  charges.mockResolvedValue(0)
})

describe("POST /api/notifications/payment", () => {
  it("never tells a client a waived balance was a payment received", async () => {
    findUnique.mockResolvedValue({
      id: "pay-1", amount: 75, paymentMethod: "WAIVER",
      loan: { reference: "LN-1", outstandingPrincipal: 0, client: { firstName: "A", lastName: "B", email: "a@b.invalid" } },
    })
    expect((await call()).status).toBe(409)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// A payment reminder is dunning: it goes out only from the reminders cron, through
// sendMessage (opt-out, holds, dedupe, send window). This route no longer sends one.
describe("POST /api/notifications/payment — due_reminder", () => {
  it("is refused with 400 and nothing is looked up or sent", async () => {
    const res = await POST(new NextRequest("http://localhost/api/notifications/payment", {
      method: "POST",
      headers: { authorization: "Bearer internal-secret" },
      body: JSON.stringify({ paymentId: "sched-1", event: "due_reminder" }),
    }))
    expect(res.status).toBe(400)
    expect(scheduleFindUnique).not.toHaveBeenCalled()
    expect(charges).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
