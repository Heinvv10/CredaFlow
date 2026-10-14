import { describe, it, expect, beforeEach, vi } from "vitest"

// The 3-day payment reminder for an ENTITY borrower (asset finance, goal
// §4.11): email and WhatsApp to each director / trustee / authorised
// signatory through sendMessage(), never SMS, never the direct email sender.

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  noteFindFirst: vi.fn(),
  noteCreate: vi.fn(),
  templateFindFirst: vi.fn(),
  relationships: vi.fn(),
  sendMessage: vi.fn(),
  lookupContact: vi.fn(),
  sendEmail: vi.fn(),
  availability: vi.fn(),
  charges: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    repaymentSchedule: { findMany: h.findMany },
    loanNote: { findFirst: h.noteFindFirst, create: h.noteCreate },
    messageTemplate: { findFirst: h.templateFindFirst },
    entityRelationship: { findMany: h.relationships },
  },
}))
vi.mock("@/lib/messaging/send", async (orig) => ({ ...(await orig<typeof import("@/lib/messaging/send")>()), sendMessage: h.sendMessage }))
vi.mock("@/lib/contact/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/contact/identity")>()),
  lookupContactByChannelValue: h.lookupContact,
}))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => null }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: async () => "t1" }))
vi.mock("@/lib/config/identity", async (orig) => {
  const actual = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { ...actual, getLenderIdentity: async () => actual.parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: async () => ({ whatsappEnabled: true, waProvider: "WA_CLOUD" }) }))
vi.mock("@/lib/email/service", () => ({ sendEmail: h.sendEmail }))
vi.mock("@/lib/messaging/channel-availability", () => ({ getChannelAvailability: h.availability }))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: h.charges }))

import { GET } from "./route"
import type { NextRequest } from "next/server"

function entityScheduleDueIn(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(12, 0, 0, 0)
  return {
    id: "s_af", dueDate: d, totalDue: 500_000, totalPaid: 100_000,
    loan: { id: "l_af", reference: "LN-AF-2", client: null, entityId: "ent_1", entity: { legalName: "TEST Earthmoving (Pty) Ltd" } },
  }
}

const run = () => GET({} as NextRequest)

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.BULKSMS_DRY_RUN // SMS "on": still never used here
  h.noteFindFirst.mockResolvedValue(null)
  h.noteCreate.mockResolvedValue({})
  h.charges.mockResolvedValue(5_000)
  h.relationships.mockResolvedValue([
    { client: { id: "cl_1", firstName: "Jane", lastName: "Testperson", email: "jane@example.test", whatsapp: "0820000001" } },
  ])
  h.templateFindFirst.mockImplementation(async (a: { where: { key: string; channel: string } }) => ({
    id: `tpl_${a.where.key}`, key: a.where.key, channel: a.where.channel, statutoryOverride: false,
  }))
  h.lookupContact.mockImplementation(async (_db: unknown, a: { value: string }) => ({ id: `ct_${a.value}` }))
  h.sendMessage.mockResolvedValue({ id: "msg", status: "SENT" })
})

describe("payment-reminders — entity borrower", () => {
  it("emails and WhatsApps each authorised person in the entity copy, and marks the instalment", async () => {
    h.findMany.mockResolvedValue([entityScheduleDueIn(3)])
    const body = await (await run()).json()

    expect(body).toMatchObject({ due: 1, sent: 1, failed: 0 })
    expect(h.sendEmail).not.toHaveBeenCalled()
    expect(h.availability).not.toHaveBeenCalled()
    const calls = h.sendMessage.mock.calls.map(([a]) => a as { channel: string; template: { key: string }; vars: Record<string, string> })
    expect(calls.map((c) => [c.channel, c.template.key])).toEqual([
      ["EMAIL", "entity_reminder_email"],
      ["WHATSAPP", "entity_payment_due_whatsapp"],
    ])
    expect(calls[0].vars.subject).toBe("Payment reminder: TEST Earthmoving (Pty) Ltd (LN-AF-2)")
    // The unpaid instalment plus charges owed: 5000.00 - 1000.00 + 50.00.
    expect(calls[0].vars.text).toContain("A payment of R 4,050.00 on the Acme Lending account of TEST Earthmoving (Pty) Ltd (reference LN-AF-2)")
    expect(calls[0].vars.text).not.toMatch(/\byour (loan|payment|account)\b/i)
    expect(h.noteCreate).toHaveBeenCalledTimes(1)
    expect(h.noteCreate.mock.calls[0][0].data).toMatchObject({ loanId: "l_af", type: "payment_due_reminder" })
  })

  it("a definite failure on every leg leaves the instalment unmarked for the next run", async () => {
    h.findMany.mockResolvedValue([entityScheduleDueIn(2)])
    h.lookupContact.mockResolvedValue(null)
    const body = await (await run()).json()
    expect(body).toMatchObject({ due: 1, sent: 0, failed: 1 })
    expect(h.noteCreate).not.toHaveBeenCalled()
  })

  it("a skip period's R0.00 row is not a payment due: nothing is sent or counted", async () => {
    h.findMany.mockResolvedValue([{ ...entityScheduleDueIn(3), totalDue: 0, totalPaid: 0 }])
    const body = await (await run()).json()
    expect(body).toMatchObject({ due: 0, sent: 0 })
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.noteCreate).not.toHaveBeenCalled()
  })

  it("an entity already reminded in the window is skipped", async () => {
    h.findMany.mockResolvedValue([entityScheduleDueIn(1)])
    h.noteFindFirst.mockResolvedValue({ id: "n" })
    const body = await (await run()).json()
    expect(body).toMatchObject({ due: 1, skipped: 1, sent: 0 })
    expect(h.sendMessage).not.toHaveBeenCalled()
  })
})
