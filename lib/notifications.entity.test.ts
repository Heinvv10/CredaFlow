import { describe, it, expect, vi, beforeEach } from "vitest"

// triggerNotification for a loan with no Client: an entity borrower's event is
// handed to lib/asset-finance/entity-notifications.ts instead of being logged
// as "Client not found".

const h = vi.hoisted(() => ({
  loanFindUnique: vi.fn(),
  applicationFindUnique: vi.fn(),
  logCreate: vi.fn(),
  notifyEntity: vi.fn(),
  sendEmail: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: h.loanFindUnique },
    loanApplication: { findUnique: h.applicationFindUnique },
    notificationLog: { create: h.logCreate },
  },
}))
vi.mock("@/lib/asset-finance/entity-notifications", () => ({ notifyEntityBorrower: h.notifyEntity }))
vi.mock("@/lib/email/service", () => ({ sendEmail: h.sendEmail }))
vi.mock("@/lib/messaging/send", async (orig) => ({ ...(await orig<typeof import("@/lib/messaging/send")>()), sendMessage: h.sendMessage }))

import { triggerNotification } from "./notifications"

const opts = { tenantId: "t1", event: "payment_received" as const, loanId: "l_af", data: { amount: 100, paymentId: "p1" } }

beforeEach(() => {
  vi.clearAllMocks()
  h.loanFindUnique.mockResolvedValue({ id: "l_af", client: null })
  h.applicationFindUnique.mockResolvedValue(null)
  h.logCreate.mockResolvedValue({})
})

describe("triggerNotification — entity borrower", () => {
  it("hands the event to the entity path and sends nothing to a consumer", async () => {
    h.notifyEntity.mockResolvedValue(true)
    await triggerNotification(opts)
    expect(h.notifyEntity).toHaveBeenCalledWith(opts, expect.any(Function))
    expect(h.logCreate).not.toHaveBeenCalled()
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it("the entity path's log writer writes NotificationLog rows for this tenant", async () => {
    h.notifyEntity.mockImplementation(async (_o: unknown, log: (r: Record<string, unknown>) => Promise<void>) => {
      await log({ loanId: "l_af", clientId: "cl_a", event: "payment_received", channel: "email", status: "sent", messageId: "m1" })
      return true
    })
    await triggerNotification(opts)
    expect(h.logCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "t1", loanId: "l_af", clientId: "cl_a", channel: "email", status: "sent", messageId: "m1" }),
    })
  })

  it("no Client and not an entity loan: still logged as Client not found", async () => {
    h.notifyEntity.mockResolvedValue(false)
    await triggerNotification(opts)
    expect(h.logCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "failed", error: "Client not found" }) })
  })
})
