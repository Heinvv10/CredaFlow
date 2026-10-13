import { describe, it, expect, beforeEach, vi } from "vitest"

const h = vi.hoisted(() => ({
  loanFindFirst: vi.fn(),
  relationships: vi.fn(),
  templateFindFirst: vi.fn(),
  lookupContact: vi.fn(),
  sendMessage: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: h.loanFindFirst },
    entityRelationship: { findMany: h.relationships },
    messageTemplate: { findFirst: h.templateFindFirst },
  },
}))
vi.mock("@/lib/messaging/send", async (orig) => ({ ...(await orig<typeof import("@/lib/messaging/send")>()), sendMessage: h.sendMessage }))
vi.mock("@/lib/contact/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/contact/identity")>()),
  lookupContactByChannelValue: h.lookupContact,
}))
vi.mock("@/lib/config/identity", async (orig) => {
  const actual = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { ...actual, getLenderIdentity: async () => actual.parseLenderIdentity(VALID_LENDER_COLUMNS) }
})

import { notifyEntityBorrower } from "./entity-notifications"
import { SendBlockedError } from "@/lib/messaging/send"

const ENTITY_LOAN = { id: "l_af", reference: "LN-AF-3", outstandingPrincipal: 9_000_000, entityId: "ent_1", entity: { legalName: "TEST Earthmoving (Pty) Ltd" } }
const person = (id: string, whatsapp: string | null) => ({
  client: { id, firstName: id === "cl_a" ? "Ann" : "Bo", lastName: "Testperson", email: `${id}@example.test`, whatsapp },
})
type LogRow = { clientId?: string; channel: string; status: string; error?: string }
const log = vi.fn(async (_row: LogRow) => undefined)
const received = (data: Record<string, unknown> = { amount: 1_234_500, paymentId: "pay_1" }) =>
  notifyEntityBorrower({ tenantId: "t1", event: "payment_received", loanId: "l_af", data }, log)

beforeEach(() => {
  vi.clearAllMocks()
  h.loanFindFirst.mockResolvedValue(ENTITY_LOAN)
  h.relationships.mockResolvedValue([person("cl_a", "0820000001"), person("cl_b", null)])
  h.templateFindFirst.mockImplementation(async (a: { where: { key: string; channel: string } }) => ({
    id: `tpl_${a.where.key}`, key: a.where.key, channel: a.where.channel, statutoryOverride: false,
  }))
  h.lookupContact.mockImplementation(async (_db: unknown, a: { value: string }) => ({ id: `ct_${a.value}` }))
  h.sendMessage.mockResolvedValue({ id: "msg", status: "SENT" })
})

describe("notifyEntityBorrower", () => {
  it("leaves a consumer loan to the consumer path", async () => {
    h.loanFindFirst.mockResolvedValue({ ...ENTITY_LOAN, entityId: null, entity: null })
    expect(await received()).toBe(false)
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it("leaves events it does not cover to the consumer path, without reading the loan", async () => {
    expect(await notifyEntityBorrower({ tenantId: "t1", event: "loan_disbursed", loanId: "l_af" }, log)).toBe(false)
    expect(h.loanFindFirst).not.toHaveBeenCalled()
  })

  it("a receipt: TRANSACTIONAL email to every authorised person, WhatsApp where on file, a log row per leg", async () => {
    expect(await received()).toBe(true)
    const calls = h.sendMessage.mock.calls.map(([a]) => a as { channel: string; template: { key: string }; vars: Record<string, string>; idempotencyKey: string; loanId: string })
    expect(calls.map((c) => [c.channel, c.template.key])).toEqual([
      ["EMAIL", "entity_payment_received_email"],
      ["EMAIL", "entity_payment_received_email"],
      ["WHATSAPP", "entity_payment_received_whatsapp"],
    ])
    expect(calls.every((c) => c.loanId === "l_af" && c.idempotencyKey.includes("payment_received:pay_1"))).toBe(true)
    expect(calls[0].vars.text).toContain("We have received a payment of R 12,345.00 on the Acme Lending account of TEST Earthmoving (Pty) Ltd")
    expect(calls[0].vars.text).toContain("The outstanding balance is R 90,000.00.")
    expect(calls[2].vars).toMatchObject({ firstName: "Ann", amount: "R 12,345.00", outstanding: "R 90,000.00", entityName: "TEST Earthmoving (Pty) Ltd" })
    const rows = log.mock.calls.map(([r]) => r)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: "cl_a", channel: "email", status: "sent" }),
      expect.objectContaining({ clientId: "cl_b", channel: "email", status: "sent" }),
      expect.objectContaining({ clientId: "cl_a", channel: "whatsapp", status: "sent" }),
      expect.objectContaining({ clientId: "cl_b", channel: "whatsapp", status: "blocked", error: "No WhatsApp on file" }),
    ]))
    expect(rows.some((r) => r.channel === "sms")).toBe(false)
  })

  it("consent refusal is a blocked leg for that person only", async () => {
    h.sendMessage.mockImplementation(async (a: { contactId: string }) => {
      if (a.contactId === "ct_cl_b@example.test") throw new SendBlockedError("CHANNEL_OPTED_OUT")
      return { id: "msg", status: "SENT" }
    })
    await received()
    const rows = log.mock.calls.map(([r]) => r)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: "cl_a", channel: "email", status: "sent" }),
      expect.objectContaining({ clientId: "cl_b", channel: "email", status: "blocked" }),
    ]))
  })

  it("an overdue notice with its WhatsApp suppressed sends email only and records the suppression", async () => {
    await notifyEntityBorrower({
      tenantId: "t1", event: "loan_overdue", loanId: "l_af", data: { amount: 50_000, daysOverdue: 3 }, suppressWhatsAppReason: "stage has its own WhatsApp",
    }, log)
    const calls = h.sendMessage.mock.calls.map(([a]) => a as { channel: string; template: { key: string }; vars: Record<string, string> })
    expect(calls.map((c) => c.channel)).toEqual(["EMAIL", "EMAIL"])
    expect(calls[0].template.key).toBe("entity_reminder_email")
    expect(calls[0].vars.subject).toBe("Payment overdue: TEST Earthmoving (Pty) Ltd (LN-AF-3)")
    expect(calls[0].vars.text).toContain("is overdue by 3 days")
    expect(log.mock.calls.filter(([r]) => r.channel === "whatsapp")).toHaveLength(2)
  })

  it("a receipt without its Payment id sends nothing and says why", async () => {
    expect(await received({ amount: 100 })).toBe(true)
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error: expect.stringContaining("paymentId") }))
  })

  it("an entity with nobody authorised to notify is logged, not dropped", async () => {
    h.relationships.mockResolvedValue([])
    expect(await received()).toBe(true)
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ channel: "all", status: "failed" }))
  })
})
