import { describe, it, expect, vi, beforeEach } from "vitest"
import { Prisma } from "@prisma/client"

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
  emailConfigFindUnique: vi.fn(),
}))

const holds = vi.hoisted(() => ({ held: false }))
vi.mock("@/lib/collections/client-holds", () => ({ isLoanRemindable: async () => !holds.held }))
const ensureDpdCurrentMock = vi.fn()
const reserveOnceMock = vi.fn()
const releaseReservationMock = vi.fn()
vi.mock("@/lib/ops/send-reservation", () => ({
  reserveOnce: (...a: unknown[]) => reserveOnceMock(...a),
  releaseReservation: (...a: unknown[]) => releaseReservationMock(...a),
}))
const seedDefaultMessageTemplatesMock = vi.fn()
vi.mock("@/lib/messaging/default-templates", () => ({ seedDefaultMessageTemplates: (...a: unknown[]) => seedDefaultMessageTemplatesMock(...a) }))
vi.mock("@/lib/loan/dpd-update", () => ({ ensureDpdCurrent: (...a: unknown[]) => ensureDpdCurrentMock(...a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: async (a: unknown) => { const t = await m.tenantFindFirst(a); return Array.isArray(t) ? t : t ? [t] : [] } },
    loan: { findMany: m.loanFindMany },
    repaymentSchedule: { findFirst: m.scheduleFindFirst },
    loanNote: { findFirst: m.loanNoteFindFirst, create: m.loanNoteCreate },
    messageTemplate: { findFirst: m.templateFindFirst },
    tenantConfig: { findUnique: async () => ({}) },
    emailConfig: { findUnique: m.emailConfigFindUnique },
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
// The send window is the clock's: pinned open here.
vi.mock("@/lib/collections/send-window", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/send-window")>()),
  outsideDunningSendWindow: () => false,
}))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: m.chargesOutstandingAt }))

import { processPaymentReminders } from "./reminders"
import { WABA_BODY_TEMPLATES } from "@/lib/whatsapp/template-vars"
import { sastStartOfDay } from "@/lib/date/sast"
import { normaliseEmail, toWaJid } from "@/lib/contact/identity"

function entityLoanDueIn(days: number) {
  const due = new Date(sastStartOfDay(new Date()).getTime() + days * 86_400_000)
  return {
    id: "loan_af", reference: "LN-AF-1", nextPaymentDate: due, arrearsAmount: 250_000, status: "ACTIVE" as const,
    client: null, entityId: "ent_1", entity: { legalName: "TEST Earthmoving (Pty) Ltd" },
  }
}

// Whose Contact each email address and WhatsApp number is: a person's own, as
// person() registers it. The dispatch refuses a Contact that is someone else's.
const owners = new Map<string, string>()
const person = (id: string, firstName: string, whatsapp: string | null) => {
  owners.set(normaliseEmail(`${id}@example.test`), id)
  if (whatsapp) owners.set(toWaJid(whatsapp), id)
  return personRow(id, firstName, whatsapp)
}
const personRow = (id: string, firstName: string, whatsapp: string | null) => ({
  client: { id, firstName, lastName: "Testperson", email: `${id}@example.test`, whatsapp },
})

beforeEach(() => {
  vi.resetAllMocks()
  // SMS ON: the entity path must not use it even when the channel is enabled.
  process.env.BULKSMS_DRY_RUN = "false"
  m.tenantFindFirst.mockResolvedValue({ id: "tenant_acme", name: "Acme" })
  m.scheduleFindFirst.mockResolvedValue({ totalDue: 300_000, totalPaid: 0 })
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
  m.lookupContact.mockImplementation(async (_db: unknown, a: { value: string }) => ({ id: `ct_${a.value}`, clientId: owners.get(a.value) ?? null }))
  m.sendMessage.mockResolvedValue({ id: "msg", status: "SENT" })
  m.triggerNotification.mockResolvedValue(undefined)
  m.emailConfigFindUnique.mockResolvedValue({ active: true })
  reserveOnceMock.mockResolvedValue(true)
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

  it("1 day before due: one WhatsApp and one email per person (never SMS), entity-naming templates, a LoanNote", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()

    expect(m.sendSms).not.toHaveBeenCalled()
    expect(m.sendWhatsApp).not.toHaveBeenCalled()
    const calls = m.sendMessage.mock.calls.map(([a]) => a as { channel: string; template: { key: string }; vars: Record<string, string>; idempotencyKey: string })
    const whatsapp = calls.filter((c) => c.channel === "WHATSAPP")
    const email = calls.filter((c) => c.channel === "EMAIL")
    expect(calls).toHaveLength(4)
    expect(whatsapp).toHaveLength(2)
    expect(email).toHaveLength(2)
    expect(whatsapp.every((c) => c.template.key === "entity_payment_due_whatsapp")).toBe(true)
    expect(email.every((c) => c.template.key === "entity_reminder_email")).toBe(true)
    expect(whatsapp[0].vars).toMatchObject({ firstName: "Jane", entityName: "TEST Earthmoving (Pty) Ltd", reference: "LN-AF-1", amount: "R 3,123.45" })
    expect(new Set(calls.map((c) => c.idempotencyKey)).size).toBe(4)
    // The report names the loan, not the borrower.
    expect(r.details.join("\n")).not.toContain("TEST Earthmoving")
    expect(r.details.join("\n")).toContain("LN-AF-1")
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

  it("WhatsApp off: the entity leg is skipped before sendMessage, counted, not an error; loan_overdue still goes", async () => {
    process.env.WA_ENABLED = "false"
    try {
      m.loanFindMany.mockResolvedValue([entityLoanDueIn(-3)])
      const r = await processPaymentReminders()

      expect(m.sendMessage).not.toHaveBeenCalled()
      expect(m.relationshipFindMany).not.toHaveBeenCalled()
      expect(r.errors).toBe(0)
      expect(r.whatsappChannelOff).toBe(1)
      expect(m.triggerNotification).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.WA_ENABLED
    }
  })

  it("WhatsApp off, 1 day before due: only the email leg goes to the people who act for the entity", async () => {
    process.env.WA_ENABLED = "false"
    try {
      m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
      const r = await processPaymentReminders()

      expect(m.sendMessage.mock.calls.map(([a]) => (a as { channel: string }).channel)).toEqual(["EMAIL", "EMAIL"])
      expect(r.errors).toBe(0)
      expect(r.whatsappChannelOff).toBe(1)
      expect(m.loanNoteCreate).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.WA_ENABLED
    }
  })

  // The consumer email leg is skipped for a tenant that cannot send email (reminders.ts,
  // emailLegSkipReason); the entity leg is the same pre-due email, so it must be too.
  it.each([
    ["has no active email provider", () => m.emailConfigFindUnique.mockResolvedValue({ active: false })],
    ["has no email provider row", () => m.emailConfigFindUnique.mockResolvedValue(null)],
    ["has no entity_reminder_email template", () => m.templateFindFirst.mockImplementation(async (a: { where: { key: string; channel: string } }) =>
      a.where.key === "entity_reminder_email" ? null : {
        id: `tpl_${a.where.key}`, tenantId: "tenant_acme", key: a.where.key, channel: a.where.channel,
        statutoryOverride: false, body: "{{body}}", bodyTemplate: null,
      })],
  ])("an entity loan, 1 day before due, for a tenant that %s: the WhatsApp goes, the email leg is skipped with one warning", async (_name, arrange) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    arrange()
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()

    const channels = m.sendMessage.mock.calls.map(([a]) => (a as { channel: string }).channel)
    expect(channels).toEqual(["WHATSAPP", "WHATSAPP"])
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(0)
    expect(r.details.filter((d) => d.startsWith("Warning: email reminder leg skipped"))).toHaveLength(1)
  })

  it("a recipient with no Contact row is reported without the address or number", async () => {
    m.lookupContact.mockResolvedValue(null)
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(r.details.join("\n")).toContain("No Contact row")
    expect(r.details.join("\n")).not.toMatch(/example\.test|0820000|27820000/)
  })

  it("an unusable consumer email template does not switch off the entity email leg", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    m.templateFindFirst.mockImplementation(async (a: { where: { key: string; channel: string } }) =>
      a.where.key === "payment_reminder_email" ? null : {
        id: `tpl_${a.where.key}`, tenantId: "tenant_acme", key: a.where.key, channel: a.where.channel,
        statutoryOverride: false, body: "{{body}}", bodyTemplate: null,
      })
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(m.sendMessage.mock.calls.map(([a]) => (a as { channel: string }).channel).sort()).toEqual(["EMAIL", "EMAIL", "WHATSAPP", "WHATSAPP"])
    expect(r.warnings).toBe(1)
  })

  it("a database fault inside an entity send fails the tenant, and the leg that did go out is still recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    m.sendMessage.mockResolvedValueOnce({ id: "msg", status: "SENT" }).mockRejectedValue(new Prisma.PrismaClientInitializationError("can't reach", "5.22.0"))
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(r.failedTenants).toBe(1)
    expect(m.loanNoteCreate, "the WhatsApp that went out has its note").toHaveBeenCalledTimes(1)
  })

  it("a database fault in the entity overdue notification fails the tenant; any other error is that loan's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(-3)])
    m.triggerNotification.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("closed", { code: "P1017", clientVersion: "5.22.0" }))
    expect((await processPaymentReminders()).failedTenants).toBe(1)
    m.triggerNotification.mockRejectedValue(new Error("smtp"))
    const r = await processPaymentReminders()
    expect(r.errors).toBeGreaterThan(0)
    expect(r.details.join("\n")).toContain("loan_overdue: failed")
  })

  it("one entity loan's failure is counted and the next loan is still reminded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    m.relationshipFindMany.mockRejectedValueOnce(new Error("connection reset"))
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1), { ...entityLoanDueIn(1), id: "loan_af2", reference: "LN-AF-2" }])
    const r = await processPaymentReminders()
    expect(r.failedTenants).toBe(0)
    expect(r.errors).toBe(1)
    expect(r.details).toContainEqual("Error LN-AF-1: failed; see the server log")
    expect(m.sendMessage.mock.calls.length, "the second loan is reminded").toBeGreaterThan(0)
  })

  it("a person without WhatsApp is skipped and reported, their email still goes; no LoanNote when nobody was reached", async () => {
    m.relationshipFindMany.mockResolvedValue([person("cl_jane", "Jane", null)])
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(1)])
    const r = await processPaymentReminders()
    expect(m.sendMessage.mock.calls.map(([a]) => (a as { channel: string }).channel)).toEqual(["EMAIL"])
    expect(m.loanNoteCreate).toHaveBeenCalledTimes(1)
    // The report names no person; the LoanNote (a staff record) does.
    expect(r.details.join("\n")).toContain("recipient 1 whatsapp: skipped (No WhatsApp on file)")
    expect(r.details.join("\n")).not.toContain("Jane")
    expect(m.loanNoteCreate.mock.calls[0][0].data.note).toContain("Jane Testperson")

    m.sendMessage.mockClear()
    m.loanNoteCreate.mockClear()
    m.relationshipFindMany.mockResolvedValue([{ client: { id: "cl_x", firstName: "Xi", lastName: "Testperson", email: null, whatsapp: null } }])
    await processPaymentReminders()
    expect(m.sendMessage).not.toHaveBeenCalled()
    expect(m.loanNoteCreate).not.toHaveBeenCalled()
  })

  it("the entity loan_overdue notice is reserved once per loan and day, and given back if it failed", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(-3)])
    reserveOnceMock.mockResolvedValue(false)
    await processPaymentReminders()
    expect(m.triggerNotification).not.toHaveBeenCalled()

    reserveOnceMock.mockResolvedValue(true)
    m.triggerNotification.mockRejectedValue(new Error("smtp"))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    await processPaymentReminders()
    expect(reserveOnceMock).toHaveBeenCalledWith("tenant_acme", "send:loan_af:reminder_overdue_3d:loan_overdue", expect.any(Date))
    expect(releaseReservationMock).toHaveBeenCalledWith("send:loan_af:reminder_overdue_3d:loan_overdue", reserveOnceMock.mock.calls.at(-1)![2])
  })

  it("an overdue trigger sends the entity WhatsApp only: its email is the loan_overdue notification", async () => {
    m.loanFindMany.mockResolvedValue([entityLoanDueIn(-1)])
    await processPaymentReminders()
    expect(m.sendMessage.mock.calls.every(([a]) => (a as { channel: string }).channel === "WHATSAPP")).toBe(true)
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
