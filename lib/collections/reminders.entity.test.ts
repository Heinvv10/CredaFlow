import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// The collections reminder cron for an ENTITY borrower (asset finance, goal
// §4.11): no Client, so each trigger's WhatsApp leg goes to the entity's
// directors, trustees and authorised signatories, never by SMS, in the
// entity-naming copy; overdue triggers raise loan_overdue by loan.

const m = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  loanFindMany: vi.fn(),
  scheduleFindFirst: vi.fn(),
  loanNoteFindFirst: vi.fn(),
  loanNoteCreate: vi.fn(),
  templateFindFirst: vi.fn(),
  relationshipFindMany: vi.fn(),
  sendSms: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendMessage: vi.fn(),
  lookupContact: vi.fn(),
  triggerNotification: vi.fn(),
  chargesOutstandingAt: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findFirst: m.tenantFindFirst },
    loan: { findMany: m.loanFindMany },
    repaymentSchedule: { findFirst: m.scheduleFindFirst },
    loanNote: { findFirst: m.loanNoteFindFirst, create: m.loanNoteCreate },
    messageTemplate: { findFirst: m.templateFindFirst },
    entityRelationship: { findMany: m.relationshipFindMany },
  },
}))
vi.mock("@/lib/config/identity", async (orig) => {
  const real = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { ...real, getLenderIdentity: async () => real.parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/integrations/bulksms", () => ({ sendSms: m.sendSms, sendWhatsApp: m.sendWhatsApp }))
vi.mock("@/lib/messaging/send", async (orig) => ({ ...(await orig<typeof import("@/lib/messaging/send")>()), sendMessage: m.sendMessage }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: async () => ({ whatsappEnabled: true }) }))
vi.mock("@/lib/contact/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/contact/identity")>()),
  lookupContactByChannelValue: m.lookupContact,
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: m.triggerNotification }))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: m.chargesOutstandingAt }))

import { processPaymentReminders } from "./reminders"
import { WABA_BODY_TEMPLATES } from "@/lib/whatsapp/template-vars"

function entityLoanDueIn(days: number) {
  const due = new Date()
  due.setHours(0, 0, 0, 0)
  due.setDate(due.getDate() + days)
  return {
    id: "loan_af", reference: "LN-AF-1", nextPaymentDate: due, arrearsAmount: 250_000, status: "ACTIVE" as const,
    client: null, entityId: "ent_1", entity: { legalName: "TEST Earthmoving (Pty) Ltd" },
  }
}

const person = (id: string, firstName: string, whatsapp: string | null) => ({
  client: { id, firstName, lastName: "Testperson", email: `${id}@example.test`, whatsapp },
})

beforeEach(() => {
  vi.resetAllMocks()
  // SMS ON: the entity path must not use it even when the channel is enabled.
  delete process.env.BULKSMS_DRY_RUN
  process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
  m.tenantFindFirst.mockResolvedValue({ id: "tenant_acme", name: "Acme" })
  m.scheduleFindFirst.mockResolvedValue({ totalDue: 300_000 })
  m.loanNoteFindFirst.mockResolvedValue(null)
  m.loanNoteCreate.mockResolvedValue({ id: "note" })
  m.chargesOutstandingAt.mockResolvedValue(12_345)
  m.templateFindFirst.mockImplementation(async (a: { where: { key: string; channel: string } }) => ({
    id: `tpl_${a.where.key}`, tenantId: "tenant_acme", key: a.where.key, channel: a.where.channel,
    statutoryOverride: false, body: "{{body}}", bodyTemplate: null,
  }))
  // Jane holds two qualifying roles: she is ONE recipient.
  m.relationshipFindMany.mockResolvedValue([
    person("cl_jane", "Jane", "0820000001"), person("cl_jane", "Jane", "0820000001"), person("cl_sam", "Sam", "0820000002"),
  ])
  m.lookupContact.mockImplementation(async (_db: unknown, a: { value: string }) => ({ id: `ct_${a.value}` }))
  m.sendMessage.mockResolvedValue({ id: "msg", status: "SENT" })
  m.triggerNotification.mockResolvedValue(undefined)
})

afterEach(() => {
  delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
})

describe("processPaymentReminders — entity borrower", () => {
  it("asks only for ACTIVE directors, trustees and authorised signatories of the entity, alive", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    await processPaymentReminders()
    const where = m.relationshipFindMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: "tenant_acme", entityId: "ent_1", active: true, client: { deceasedAt: null } })
    expect([...where.role.in].sort()).toEqual(["AUTHORISED_SIGNATORY", "DIRECTOR", "TRUSTEE"])
    expect(where.role.in).not.toContain("SURETY")
  })

  it("1 day before due: one WhatsApp per person (never SMS), entity-naming template, a LoanNote", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()

    expect(m.sendSms).not.toHaveBeenCalled()
    expect(m.sendWhatsApp).not.toHaveBeenCalled()
    const calls = m.sendMessage.mock.calls.map(([a]) => a as { channel: string; template: { key: string }; vars: Record<string, string>; idempotencyKey: string })
    expect(calls.map((c) => c.channel)).toEqual(["WHATSAPP", "WHATSAPP"])
    expect(calls.every((c) => c.template.key === "entity_payment_due_whatsapp")).toBe(true)
    expect(calls[0].vars).toMatchObject({ firstName: "Jane", entityName: "TEST Earthmoving (Pty) Ltd", reference: "LN-AF-1", amount: "R 3,123.45" })
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(2)
    expect(m.loanNoteCreate).toHaveBeenCalledTimes(1)
    expect(m.loanNoteCreate.mock.calls[0][0].data).toMatchObject({ loanId: "loan_af", type: "reminder_1d" })
    // The amount is the next instalment that asks for money, never a skip period's R0.00 row.
    expect(m.scheduleFindFirst.mock.calls[0][0].where).toMatchObject({ loanId: "loan_af", totalDue: { gt: 0 } })
    expect(m.triggerNotification).not.toHaveBeenCalled()
    expect(r.sent).toBe(1)
    expect(r.smsChannelOff).toBe(0)
  })

  it("3 days overdue: the overdue template quoting arrears + charges, and loan_overdue raised by loan with its WhatsApp suppressed", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(-3)])
    await processPaymentReminders()

    const keys = m.sendMessage.mock.calls.map(([a]) => (a as { template: { key: string } }).template.key)
    expect(keys).toEqual(["entity_payment_overdue_whatsapp", "entity_payment_overdue_whatsapp"])
    expect((m.sendMessage.mock.calls[0][0] as { vars: Record<string, string> }).vars.amount).toBe("R 2,623.45")
    expect(m.triggerNotification).toHaveBeenCalledTimes(1)
    const opts = m.triggerNotification.mock.calls[0][0]
    expect(opts).toMatchObject({ event: "loan_overdue", loanId: "loan_af", data: { amount: 262_345, daysOverdue: 3 } })
    expect(opts).not.toHaveProperty("clientId")
    expect(opts.suppressWhatsAppReason).toContain("reminder_overdue_3d")
  })

  it("a person without WhatsApp is skipped and reported; no LoanNote when nobody was reached", async () => {
    m.relationshipFindMany.mockResolvedValue([person("cl_jane", "Jane", null)])
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(m.sendMessage).not.toHaveBeenCalled()
    expect(m.loanNoteCreate).not.toHaveBeenCalled()
    expect(r.details.join("\n")).toContain("Jane Testperson whatsapp: skipped (No WhatsApp on file)")
  })

  it("a missing entity template fails that leg loudly, never falling back to the consumer copy", async () => {
    m.templateFindFirst.mockImplementation(async (a: { where: { key: string } }) =>
      a.where.key.startsWith("entity_") ? null : { id: "x", key: a.where.key, statutoryOverride: false })
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(m.sendMessage).not.toHaveBeenCalled()
    expect(r.errors).toBeGreaterThan(0)
    expect(r.details.join("\n")).toContain("entity_payment_due_whatsapp missing")
  })

  it("the entity bodies never call the reader the borrower", () => {
    for (const event of ["entity_payment_due", "entity_payment_overdue", "entity_payment_received"]) {
      expect(WABA_BODY_TEMPLATES[event]).toContain("{{entityName}}")
      expect(WABA_BODY_TEMPLATES[event]).not.toMatch(/\byour (loan|payment|account)\b/i)
    }
  })
})
