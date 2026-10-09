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

// Default charges: the
// amount due quoted is the unpaid instalment + default charges outstanding.
describe("POST /api/notifications/payment — due_reminder amount", () => {
  const dueReminder = () => POST(new NextRequest("http://localhost/api/notifications/payment", {
    method: "POST",
    headers: { authorization: "Bearer internal-secret" },
    body: JSON.stringify({ paymentId: "sched-1", event: "due_reminder" }),
  }))

  beforeEach(() => {
    sendEmail.mockResolvedValue({ ok: true, messageId: "m1" })
    scheduleFindUnique.mockResolvedValue({
      id: "sched-1", loanId: "loan-1", totalDue: 150_000, totalPaid: 20_000, dueDate: new Date("2026-10-01T10:00:00Z"),
      loan: { reference: "LN-1", client: { firstName: "A", lastName: "B", email: "a@b.invalid" } },
    })
  })

  it("quotes the unpaid instalment + default charges outstanding", async () => {
    charges.mockResolvedValue(12_345)
    expect((await dueReminder()).status).toBe(200)
    expect(charges).toHaveBeenCalledWith(expect.anything(), { tenantId: "tenant-1", loanId: "loan-1" }, expect.any(Date))
    expect(sendEmail.mock.calls[0][0].html).toContain("R 1,423.45")
  })

  it("flag off (charges 0): the amount is unchanged", async () => {
    expect((await dueReminder()).status).toBe(200)
    expect(sendEmail.mock.calls[0][0].html).toContain("R 1,300.00")
  })
})
