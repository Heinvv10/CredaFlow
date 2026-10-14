import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  getCommsSettings: vi.fn(),
  findFirst: vi.fn(),
  lookupContact: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: { messageTemplate: { findFirst: m.findFirst } } }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: m.getCommsSettings }))
vi.mock("@/lib/contact/identity", () => ({
  lookupContactByChannelValue: m.lookupContact,
  normaliseEmail: (value: string) => value,
  toWaJid: (value: string) => value,
}))
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: m.sendMessage,
  SendBlockedError: class extends Error {},
  MessageReconciliationRequiredError: class extends Error {},
}))

import { sendEntityNotice } from "./entity-dispatch"

const request = {
  tenantId: "tenant-1",
  loanId: "loan-1",
  facts: { kind: "due" as const, entityName: "Test Entity", reference: "AF-1", amountCents: 100, dueDate: new Date("2026-11-01") },
  lender: { tradingName: "Test Lender", collectionsPhone: "0100000000" },
  recipients: [{ clientId: "client-1", firstName: "Test", lastName: "Director", email: "test@client.invalid", whatsapp: "27100000000" }],
  channels: ["EMAIL", "WHATSAPP"] as Array<"EMAIL" | "WHATSAPP">,
  occurrence: "due:2026-11-01",
  category: "payment_due",
}

beforeEach(() => {
  vi.clearAllMocks()
  m.getCommsSettings.mockResolvedValue({ whatsappEnabled: false })
  m.findFirst.mockResolvedValue({ id: "template-1", statutoryOverride: false, tenantId: "tenant-1" })
  m.lookupContact.mockResolvedValue({ id: "contact-1" })
  m.sendMessage.mockResolvedValue({ id: "message-1", status: "SENT" })
})

describe("sendEntityNotice", () => {
  it("reports WhatsApp as blocked when the tenant disabled it, while email still sends", async () => {
    const outcomes = await sendEntityNotice(request)

    expect(outcomes).toEqual([
      expect.objectContaining({ channel: "EMAIL", status: "sent" }),
      { clientId: "client-1", channel: "WHATSAPP", status: "blocked", reason: "WhatsApp channel is off" },
    ])
    expect(m.sendMessage).toHaveBeenCalledTimes(1)
    expect(m.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "EMAIL" }))
  })
})
