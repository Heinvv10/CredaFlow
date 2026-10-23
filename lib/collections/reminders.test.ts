import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const tenantFindFirstMock = vi.fn()
const loanFindManyMock = vi.fn()
const repaymentScheduleFindFirstMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const loanNoteFindFirstMock = vi.fn()
const loanNoteCreateMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const triggerNotificationMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const chargesOutstandingAtMock = vi.fn()

// WhatsApp switches (WA_ENABLED, the tenant's whatsappEnabled): a refusal reason, or null when on.
const waSwitch = vi.hoisted(() => ({ refusal: null as string | null }))
vi.mock("@/lib/whatsapp/kill-switch", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/kill-switch")>()),
  whatsappRefusalForTenant: async () => waSwitch.refusal,
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
const emailConfigFindUniqueMock = vi.fn()
const seedDefaultMessageTemplatesMock = vi.fn()
vi.mock("@/lib/messaging/default-templates", () => ({ seedDefaultMessageTemplates: (...a: unknown[]) => seedDefaultMessageTemplatesMock(...a) }))
vi.mock("@/lib/loan/dpd-update", () => ({ ensureDpdCurrent: (...a: unknown[]) => ensureDpdCurrentMock(...a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: async (a: unknown) => { const t = await tenantFindFirstMock(a); return Array.isArray(t) ? t : t ? [t] : [] } },
    loan: {
      findMany: (a: unknown) => loanFindManyMock(a),
      findUnique: (a: unknown) => loanFindUniqueMock(a),
    },
    repaymentSchedule: { findFirst: (a: unknown) => repaymentScheduleFindFirstMock(a) },
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUniqueMock(a) },
    emailConfig: { findUnique: (a: unknown) => emailConfigFindUniqueMock(a) },
    loanNote: {
      findFirst: (a: unknown) => loanNoteFindFirstMock(a),
      create: (a: unknown) => loanNoteCreateMock(a),
    },
    messageTemplate: { findFirst: (a: unknown) => messageTemplateFindFirstMock(a) },
  },
}))
const getLenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/config/identity")>()),
  getLenderIdentity: (...args: unknown[]) => getLenderIdentityMock(...args),
}))
vi.mock("@/lib/messaging/send", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    sendMessage: (a: unknown) => sendMessageMock(a),
  }
})
// A stubbed Contact is the borrower's own (clientId "cl_1", every fixture's client)
// unless the stub names another owner: the cron refuses a Contact that is not the
// loan client's.
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    lookupContactByChannelValue: async (...args: unknown[]) => {
      const contact = (await lookupContactMock(...args)) as Record<string, unknown> | null | undefined
      return contact && !("clientId" in contact) ? { ...contact, clientId: "cl_1" } : contact
    },
  }
})
// The send window is the clock's: pinned open here, closed by the tests that need it.
const sendWindow = vi.hoisted(() => ({ outside: false }))
vi.mock("@/lib/collections/send-window", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/send-window")>()),
  outsideDunningSendWindow: () => sendWindow.outside,
}))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (a: unknown) => triggerNotificationMock(a),
}))
vi.mock("@/lib/loan/charges-replay", () => ({
  chargesOutstandingAt: (...a: unknown[]) => chargesOutstandingAtMock(...a),
}))

import {
  processPaymentReminders,
  reminderDeliveryOutcome,
  overdueWhatsAppSuppressionReason,
  TRIGGERS,
} from "./reminders"
import { KnownDispatchPersistenceError, MessageReconciliationRequiredError, SendBlockedError } from "@/lib/messaging/send"
import { WA_SETTINGS_UNAVAILABLE_REASON } from "@/lib/whatsapp/kill-switch"
import { Prisma } from "@prisma/client"
import { WABA_BODY_TEMPLATES, withSeededBrand } from "@/lib/whatsapp/template-vars"
import { extractPlaceholders } from "@/lib/whatsapp/template-components"
import { sastStartOfDay } from "@/lib/date/sast"
import { REMINDER_DAYS_UNTIL_DUE } from "@/lib/collections/reminder-offsets"
import { kabeloScheduleAsAudited } from "@/lib/loan/__fixtures__/fairscore-audit-schedules"

const sastDayOffset = (days: number) => new Date(sastStartOfDay(new Date()).getTime() + days * 86_400_000)

// The retry sweep holds a queued pre-due reminder by these offsets (lib/collections/reminder-offsets.ts):
// a trigger written with its own number would be retried on the wrong day.
describe("TRIGGERS: the days-until-due is the one the retry sweep holds by", () => {
  it("has an offset for every trigger, and a trigger for every offset", () => {
    expect(TRIGGERS.map((t) => [t.noteType, t.daysUntilDue]).sort()).toEqual(Object.entries(REMINDER_DAYS_UNTIL_DUE).sort())
  })
})

// Every payment-reminder message must quote the loan reference so the client
// puts it on their EFT deposit and the bank-sync reconciler makes an EXACT
// match. The "due TODAY" (reminder_0d) message historically omitted it.
describe("TRIGGERS — payment reference in reminder copy", () => {
  const ctx = {
    firstName: "Thabo",
    amount: "R1,500.00",
    date: "15 Jul 2026",
    loanRef: "LN-0099",
    arrearsAmount: "R1,500.00",
    lenderName: "Acme Lending",
    phone: "+27 11 000 0000",
  }

  it("includes the loan reference in every trigger's message (all channels)", () => {
    for (const trigger of TRIGGERS) {
      const msg = trigger.getMessage(ctx)
      expect(msg, `${trigger.noteType} must quote the loan reference`).toContain(ctx.loanRef)
    }
  })
})

describe("reminderDeliveryOutcome", () => {
  it.each([
    ["SENT", "sent"],
    ["DELIVERED", "sent"],
    ["READ", "sent"],
    ["SIMULATED", "simulated"],
    ["QUEUED", "pending"],
    ["RETRYING", "pending"],
    ["SUPPRESSED_BY_CONSENT", "suppressed"],
    ["FAILED", "failed"],
    ["FAILED_PERMANENT", "failed"],
    ["EXPIRED", "failed"],
    ["BOUNCED", "failed"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(reminderDeliveryOutcome(status)).toBe(expected)
  })
})

// Loan with nextPaymentDate exactly one day in the future → triggers
// reminder_1d (SMS + WhatsApp).
function loanDueTomorrow() {
  const tomorrow = sastDayOffset(1)
  return {
    id: "loan_1",
    reference: "L-001",
    nextPaymentDate: tomorrow,
    arrearsAmount: 0,
    status: "ACTIVE" as const,
    client: {
      id: "cl_1",
      firstName: "Test",
      lastName: "Client",
      phone: "0821234567",
      whatsapp: null as string | null,
    },
  }
}

// Loan with nextPaymentDate 3 days in the past → triggers reminder_overdue_3d
// (daysUntilDue: -3), which also fires the loan_overdue notification.
function loanOverdue3d() {
  const threeDaysAgo = sastDayOffset(-3)
  return {
    id: "loan_9",
    reference: "L-009",
    nextPaymentDate: threeDaysAgo,
    arrearsAmount: 156_000,
    status: "ACTIVE" as const,
    client: {
      id: "cl_1",
      firstName: "Test",
      lastName: "Client",
      phone: "0821234567",
      whatsapp: null as string | null,
    },
  }
}

const sampleSmsTpl = {
  id: "tpl_sms",
  tenantId: "tenant_acme",
  key: "payment_reminder_sms",
  channel: "SMS",
  category: "SERVICE",
  statutoryOverride: false,
  body: "{{body}}",
  bodyTemplate: null,
  subject: null,
  purposeRequired: null,
}
// One WABA-registrable row per WhatsApp trigger. The shared
// `payment_reminder_whatsapp` row is a `{{body}}` passthrough Meta rejects,
// so every out-of-window reminder failed WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE.
function waTpl(event: string) {
  return {
    ...sampleSmsTpl,
    id: `tpl_${event}`,
    key: `${event}_whatsapp`,
    channel: "WHATSAPP",
    body: withSeededBrand(WABA_BODY_TEMPLATES[event], "Seeded Brand"),
    bodyTemplate: withSeededBrand(WABA_BODY_TEMPLATES[event], "Seeded Brand"),
    wabaTemplateName: event,
  }
}

// Derived from TRIGGERS rather than hand-listed: a trigger that gains a
// WhatsApp leg without a stub here would look up a row this fixture never
// returns, and the "missing template" branch would silently absorb it.
const WA_TEMPLATE_EVENTS = TRIGGERS.filter((t) => t.waTemplateEvent).map((t) => t.waTemplateEvent!)

// Resolves findFirst by the key it asks for, so the assertion is about WHICH
// row the cron looked up rather than the order it happened to ask in.
function emailTpl(overrides: Record<string, unknown> = {}) {
  return { ...sampleSmsTpl, key: "payment_reminder_email", channel: "EMAIL", subject: "{{subject}}", body: "{{text}}", bodyTemplate: "{{html}}", ...overrides }
}

function stubTemplates(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = { payment_reminder_sms: sampleSmsTpl, payment_reminder_email: emailTpl(), entity_reminder_email: emailTpl({ key: "entity_reminder_email" }) }
  for (const e of WA_TEMPLATE_EVENTS) rows[`${e}_whatsapp`] = waTpl(e)
  Object.assign(rows, overrides)
  messageTemplateFindFirstMock.mockImplementation(
    async (a: { where: { key: string } }) => rows[a.where.key] ?? null,
  )
}

function loanDueIn(days: number) {
  const due = sastDayOffset(days)
  return {
    ...loanDueTomorrow(),
    nextPaymentDate: due,
    arrearsAmount: 156_000,
    client: { ...loanDueTomorrow().client, whatsapp: "0821234567" },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  waSwitch.refusal = null
  sendWindow.outside = false
  tenantFindFirstMock.mockResolvedValue({ id: "tenant_acme", name: "Acme" })
  loanFindManyMock.mockResolvedValue([loanDueTomorrow()])
  repaymentScheduleFindFirstMock.mockResolvedValue({ totalDue: 1500_00, totalPaid: 0 })
  tenantConfigFindUniqueMock.mockResolvedValue({})
  emailConfigFindUniqueMock.mockResolvedValue({ active: true })
  reserveOnceMock.mockResolvedValue(true)
  getLenderIdentityMock.mockImplementation(async () => {
    const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
    return parseLenderIdentity(VALID_LENDER_COLUMNS)
  })
  loanNoteFindFirstMock.mockResolvedValue(null) // not sent today
  loanNoteCreateMock.mockResolvedValue({ id: "note_1" })
  sendMessageMock.mockResolvedValue({ id: "msg_1", status: "SENT" })
  chargesOutstandingAtMock.mockResolvedValue(0)
})

describe("processPaymentReminders", () => {
  // White-label: no reminder is signed with a default name or phone.
  it("sends nothing when the lender identity is not configured", async () => {
    const { LenderIdentityError } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    getLenderIdentityMock.mockRejectedValue(new LenderIdentityError(["collectionsPhone"]))
    loanFindManyMock.mockResolvedValue([loanDueTomorrow()])
    stubTemplates()
    // Reported as the tenant's failure (the cron answers 503), not thrown: the
    // tenants after it still get their reminders.
    const result = await processPaymentReminders()
    expect(result.errors).toBe(1)
    expect(result.details.join("\n")).toContain("Tenant Acme (tenant_acme) failed")
    expect(result.details.join("\n"), "the cause stays in the server log").not.toContain("collectionsPhone")
    expect(result).toMatchObject({ tenants: 1, failedTenants: 1 })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  describe("several tenants", () => {
    it("makes sure DPD is current for each tenant, and a tenant that threw does not stop the next", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      tenantFindFirstMock.mockResolvedValue([{ id: "tenant_a", name: "A" }, { id: "tenant_b", name: "B" }])
      getLenderIdentityMock.mockImplementation(async (id: string) => {
        if (id === "tenant_a") throw new Error("identity missing")
        return { tradingName: "Acme", collectionsPhone: "0110000001" }
      })
      loanFindManyMock.mockResolvedValue([])
      const result = await processPaymentReminders()
      expect(ensureDpdCurrentMock.mock.calls.map((c) => c[0])).toEqual(["tenant_a", "tenant_b"])
      expect(result).toMatchObject({ tenants: 2, failedTenants: 1, errors: 1 })
      expect(getLenderIdentityMock).toHaveBeenCalledWith("tenant_b")
    })
  })

  describe("one loan's failure", () => {
    const withWa = (id: string, reference: string) => {
      const l = loanDueTomorrow()
      l.id = id
      l.reference = reference
      l.client.whatsapp = "0821234567"
      return l
    }

    // The loans are processed one after another; a throw from any query for one of them (the
    // already-sent check, the hold recheck, the charges replay, the LoanNote write) used to end the
    // tenant's run, so the loans after it went unreminded that day.
    it.each([
      ["the already-processed check", () => loanNoteFindFirstMock.mockRejectedValueOnce(new Error("deadlock"))],
      ["the charges replay", () => chargesOutstandingAtMock.mockRejectedValueOnce(new Error("replay failed"))],
      ["the schedule lookup", () => repaymentScheduleFindFirstMock.mockRejectedValueOnce(new Error("connection reset"))],
      ["the LoanNote write", () => loanNoteCreateMock.mockRejectedValueOnce(new Error("disk full"))],
    ])("a throw from %s is counted for that loan, with the cause in the log only, and the next loan is still reminded", async (_name, arrange) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      arrange()
      loanFindManyMock.mockResolvedValue([withWa("loan_1", "L-001"), withWa("loan_2", "L-002")])
      const r = await processPaymentReminders()

      expect(r.failedTenants, "the tenant did not fail").toBe(0)
      expect(r.errors).toBe(1)
      expect(r.details).toContainEqual("Error L-001: failed; see the server log")
      expect(JSON.stringify(r.details)).not.toMatch(/deadlock|replay failed|connection reset|disk full/)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("L-001"), expect.any(Error))
      expect(sendMessageMock.mock.calls.filter((c) => c[0].loanId === "loan_2").length, "L-002 is still reminded").toBeGreaterThanOrEqual(1)
    })
  })

  // Isolating one loan's failure must not hide a fault that is the database's: a restart mid-run would
  // otherwise be N per-loan errors on a claim that stays DONE, and the tenant would not be retried.
  describe("a fault that is not one loan's", () => {
    const loans = () => [loanDueIn(1), { ...loanDueIn(1), id: "loan_2", reference: "L-002" }].map((l) => ({ ...l, client: { ...l.client, whatsapp: "0821234567" } }))
    const known = (code: string) => new Prisma.PrismaClientKnownRequestError("msg", { code, clientVersion: "5.22.0" })

    it.each([
      ["an initialisation error", () => new Prisma.PrismaClientInitializationError("can't reach the database", "5.22.0")],
      ["a connection reset (P1017)", () => known("P1017")],
      ["a pool timeout (P2024)", () => known("P2024")],
    ])("%s fails the tenant at once, though the other loan could have been tried", async (_name, error) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValueOnce(error())
      loanFindManyMock.mockResolvedValue(loans())
      const r = await processPaymentReminders()
      expect(r).toMatchObject({ failedTenants: 1, tenants: 1 })
      expect(r.details).toContainEqual("Tenant Acme (tenant_acme) failed; see the server log")
      expect(loanNoteFindFirstMock, "the second loan was not tried against a database that is down").toHaveBeenCalledTimes(1)
    })

    it("a unique violation (P2002) on one loan is that loan's error, not the tenant's", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValueOnce(known("P2002"))
      loanFindManyMock.mockResolvedValue(loans())
      const r = await processPaymentReminders()
      expect(r).toMatchObject({ failedTenants: 0, errors: 1 })
    })

    it("every loan failing fails the tenant: it is the tenant that is broken", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValue(new Error("something systemic"))
      loanFindManyMock.mockResolvedValue(loans())
      const r = await processPaymentReminders()
      expect(r.failedTenants).toBe(1)
    })

    it("a tenant with a single loan that fails is a failed tenant too", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanNoteFindFirstMock.mockRejectedValue(new Error("boom"))
      loanFindManyMock.mockResolvedValue(loans().slice(0, 1))
      expect((await processPaymentReminders()).failedTenants).toBe(1)
    })

    it("a tenant with no loans is not failed", async () => {
      loanFindManyMock.mockResolvedValue([])
      expect((await processPaymentReminders()).failedTenants).toBe(0)
    })
  })

  describe("a database fault inside a send", () => {
    const withWa = () => {
      const l = loanDueTomorrow()
      l.client.whatsapp = "0821234567"
      return l
    }

    it("on the sendMessage path fails the tenant, like any other fault, instead of one more per-loan error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockRejectedValue(new Prisma.PrismaClientInitializationError("can't reach", "5.22.0"))
      loanFindManyMock.mockResolvedValue([withWa(), { ...withWa(), id: "loan_2", reference: "L-002" }])
      const r = await processPaymentReminders()
      expect(r.failedTenants).toBe(1)
      expect(sendMessageMock, "the next loan is not tried against a database that is down").toHaveBeenCalledTimes(1)
    })

    it("an ordinary send error on that path stays that loan's", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockRejectedValueOnce(new Error("provider down")).mockResolvedValue({ id: "m", status: "SENT" })
      loanFindManyMock.mockResolvedValue([withWa(), { ...withWa(), id: "loan_2", reference: "L-002" }])
      const r = await processPaymentReminders()
      expect(r.failedTenants).toBe(0)
      expect(r.errors).toBeGreaterThan(0)
    })
  })

  describe("SAST day key", () => {
    // The send reservation key was built from LOCAL date parts on a UTC
    // container, so the "one reminder per day" window rolled over at 02:00
    // SAST. A notice dispatched at 00:30 was filed under YESTERDAY, and the
    // same SAST day's later run got a different key and dispatched again —
    // the borrower receives the same overdue notice twice before breakfast.
    //
    // This shape is invisible to scripts/check-date-boundaries.ts: the key is
    // assembled from getters into a string and never constructs a Date.
    afterEach(() => vi.useRealTimers())

    async function keyAt(iso: string): Promise<string> {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(iso))
      // nextPaymentDate must track the faked clock, or the trigger no longer matches.
      const due = new Date(new Date(iso).getTime() + 24 * 60 * 60 * 1000)
      const loan = loanDueTomorrow()
      loan.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([{ ...loan, nextPaymentDate: due }])
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockClear()
      await processPaymentReminders()
      const call = sendMessageMock.mock.calls[0]
      return (call?.[0] as { idempotencyKey?: string })?.idempotencyKey ?? ""
    }

    it("uses the SAST calendar day, so 00:30 and 08:00 share one reservation", async () => {
      const midnight = await keyAt("2026-08-19T22:30:00Z") // 00:30 SAST on 20 Aug
      const morning = await keyAt("2026-08-20T06:00:00Z")  // 08:00 SAST, same SAST day

      expect(midnight, "no send captured — the fixture stopped matching").not.toBe("")
      expect(midnight).toContain("2026-08-20")
      expect(morning).toBe(midnight)
    })
  })

  describe("the pre-due email leg", () => {
    const withEmail = (days: number, email: string | null = "tester@client.invalid") => {
      const loan = loanDueIn(days)
      return { ...loan, client: { ...loan.client, email } }
    }
    const emailCalls = () => sendMessageMock.mock.calls.map((c) => c[0] as { channel: string; category: string; vars: Record<string, string>; idempotencyKey: string; toValue: string; template: { key: string } })
      .filter((c) => c.channel === "EMAIL")

    beforeEach(() => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
    })

    it.each([7, 1, 0])("%i days before due: one email through sendMessage, as dunning, beside the WhatsApp and SMS legs", async (days) => {
      loanFindManyMock.mockResolvedValue([withEmail(days)])
      const r = await processPaymentReminders()

      expect(emailCalls()).toHaveLength(1)
      const call = emailCalls()[0]
      expect(call).toMatchObject({ category: "collections", toValue: "tester@client.invalid", template: { key: "payment_reminder_email" } })
      expect(call.idempotencyKey).toMatch(/^collections:loan_1:reminder_\d+d:EMAIL:\d{4}-\d{2}-\d{2}$/)
      expect(call.vars.subject).toContain("R 1,500.00")
      expect(call.vars.text).toContain("L-001")
      expect(call.vars.html).toBe(`<p>${call.vars.text}</p>`)
      expect(sendMessageMock.mock.calls.map((c) => c[0].channel).sort()).toEqual(["EMAIL", "SMS", "WHATSAPP"])
      expect(r.errors).toBe(0)
    })

    it("the email copy never tells the borrower to reply STOP (an SMS convention)", async () => {
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      await processPaymentReminders()
      expect(emailCalls()[0].vars.text).not.toContain("STOP")
    })

    it("an overdue trigger has no email leg: its email is the loan_overdue notification", async () => {
      loanFindManyMock.mockResolvedValue([withEmail(-1)])
      await processPaymentReminders()
      expect(emailCalls()).toHaveLength(0)
    })

    it("a borrower without an email address is skipped and counted, not an error", async () => {
      loanFindManyMock.mockResolvedValue([withEmail(7, null)])
      const r = await processPaymentReminders()
      expect(emailCalls()).toHaveLength(0)
      expect(r.errors).toBe(0)
      expect(r.details.join("\n")).toContain("Skipped 1 email leg(s) this run: no email address on file (reminder_7d x1)")
    })

    it("a failed send is a generic line in the report; the cause goes to the log only", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      sendMessageMock.mockRejectedValue(new Error("smtp password rejected for mailer@secret.invalid"))
      const r = await processPaymentReminders()
      expect(r.errors).toBeGreaterThan(0)
      expect(r.details.join("\n")).toContain("Error L-001 email: failed; see the server log")
      expect(JSON.stringify(r)).not.toContain("secret.invalid")
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("L-001 email failed"), expect.objectContaining({ message: expect.stringContaining("secret.invalid") }))
      logged.mockRestore()
    })

    it("a blocked send (opt-out, hold) is a skip, never an error", async () => {
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      sendMessageMock.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))
      const r = await processPaymentReminders()
      expect(r.errors).toBe(0)
      expect(r.details.join("\n")).toContain("L-001 email: blocked")
    })

    // A tenant that cannot send the email leg skips it for the whole run: one
    // warning, no error (so the cron is not 503), and the other legs still go.
    it.each([
      ["has no payment_reminder_email template", () => stubTemplates({ payment_reminder_email: undefined }), "template payment_reminder_email is missing or inactive"],
      ["has a template that bypasses consent", () => stubTemplates({ payment_reminder_email: emailTpl({ statutoryOverride: true }) }), "statutoryOverride=true"],
      ["has no active email provider", () => emailConfigFindUniqueMock.mockResolvedValue({ active: false }), "no active email provider"],
      ["has no email provider row", () => emailConfigFindUniqueMock.mockResolvedValue(null), "no active email provider"],
    ])("a tenant that %s: the email leg is skipped with one tenant warning, not an error per loan", async (_name, arrange, reason) => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      arrange()
      loanFindManyMock.mockResolvedValue([withEmail(7), { ...withEmail(7), id: "loan_2", reference: "L-002" }])
      const r = await processPaymentReminders()
      expect(emailCalls()).toHaveLength(0)
      expect(r.errors).toBe(0)
      expect(r.warnings).toBe(1)
      expect(r.details.filter((d) => d.startsWith("Warning: email reminder leg skipped"))).toHaveLength(1)
      expect(r.details.join("\n")).toContain(reason)
      expect(warned).toHaveBeenCalledTimes(1)
      expect(sendMessageMock.mock.calls.filter((c) => c[0].channel === "WHATSAPP"), "the other legs are unaffected").toHaveLength(2)
      warned.mockRestore()
    })

    // One unusable entity template used to switch the consumer email leg off too (and the reverse).
    it("an unusable entity email template does not switch off the consumer email leg, and says which leg is skipped", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined)
      stubTemplates({ entity_reminder_email: undefined })
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      const r = await processPaymentReminders()
      expect(emailCalls(), "consumer email still goes").toHaveLength(1)
      expect(r.warnings).toBe(1)
      expect(r.details).toContainEqual(expect.stringMatching(/^Warning: email reminder leg skipped for tenant Acme \(entity loans\): template entity_reminder_email is missing/))
    })

    it("an unusable consumer email template does not switch off the entity email leg", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined)
      stubTemplates({ payment_reminder_email: undefined })
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      const r = await processPaymentReminders()
      expect(emailCalls()).toHaveLength(0)
      expect(r.details).toContainEqual(expect.stringMatching(/\(consumer loans\): template payment_reminder_email is missing/))
      expect(r.details.filter((d) => d.includes("(entity loans)"))).toHaveLength(0)
    })

    it("seeds the tenant's missing reminder templates when the run starts, under its brand name, and only those", async () => {
      tenantConfigFindUniqueMock.mockResolvedValue({ brandName: "Beta Credit" })
      loanFindManyMock.mockResolvedValue([])
      await processPaymentReminders()
      expect(seedDefaultMessageTemplatesMock).toHaveBeenCalledWith(expect.anything(), "tenant_acme", "Beta Credit", { only: expect.any(Function) })
      const { only } = seedDefaultMessageTemplatesMock.mock.calls[0][3] as { only: (t: { key: string }) => boolean }
      for (const key of ["payment_reminder_email", "payment_reminder_sms", "payment_reminder_7d_whatsapp", "entity_reminder_email", "entity_payment_due_whatsapp", "loan_overdue_email"]) {
        expect(only({ key }), key).toBe(true)
      }
      for (const key of ["portal_activation_email", "otp_whatsapp", "agreement_delivery_email", "application_declined_sms"]) {
        expect(only({ key }), key).toBe(false)
      }
    })

    it("a seeding failure is logged and does not stop the run", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      seedDefaultMessageTemplatesMock.mockRejectedValue(new Error("db hiccup"))
      loanFindManyMock.mockResolvedValue([withEmail(7)])
      const r = await processPaymentReminders()
      expect(r.failedTenants).toBe(0)
      expect(emailCalls()).toHaveLength(1)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("could not seed the default message templates"), expect.any(Error))
      logged.mockRestore()
    })
  })

  // Each leg's once-a-day reservation is sendMessage's idempotency key: a Message row committed under a
  // database-unique key before the provider is called. An overlapping run (a takeover of a runner that only lost
  // its heartbeat) gets that row back instead of sending again.
  describe("send reservation (overlapping runs)", () => {
    const withWa = () => {
      const l = loanDueTomorrow()
      l.client.whatsapp = "0821234567"
      return l
    }
    beforeEach(() => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      loanFindManyMock.mockResolvedValue([withWa()])
    })

    it("reserves each send per loan, trigger, channel and SAST day before it goes", async () => {
      await processPaymentReminders()
      const keys = sendMessageMock.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey)
      expect(keys).toEqual([
        expect.stringMatching(/^collections:loan_1:reminder_1d:SMS:\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^collections:loan_1:reminder_1d:WHATSAPP:\d{4}-\d{2}-\d{2}$/),
      ])
    })

    it("a send another run has already reserved (its message still queued) is not recorded or counted again", async () => {
      sendMessageMock.mockResolvedValue({ id: "msg_1", status: "QUEUED" })
      const r = await processPaymentReminders()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
      expect(r.details.join("\n")).toContain("Skip duplicate reminder_1d for L-001 via sms+whatsapp: durable business reservation already active")
      expect(r).toMatchObject({ sent: 0, errors: 0 })
    })

    it("a send the provider definitely rejected is an error and writes no note, so nothing claims it went", async () => {
      sendMessageMock.mockResolvedValue({ id: "msg_1", status: "FAILED_PERMANENT" })
      const r = await processPaymentReminders()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
      expect(r.errors, "one per leg").toBe(2)
      expect(r.reconciliationRequired).toBe(0)
    })

    // A timeout, a 5xx or a response with no id: the provider may have accepted it, so a resend could message
    // the borrower twice. sendMessage keeps the reservation and refuses automatic replay.
    it("an ambiguous provider outcome is held for reconciliation, not counted an error, and its note is the marker", async () => {
      const { MessageReconciliationRequiredError } = await vi.importActual<typeof import("@/lib/messaging/send")>("@/lib/messaging/send")
      const ambiguous = Object.assign(Object.create(MessageReconciliationRequiredError.prototype) as Error, {
        message: "reconciliation required",
        messageRecord: { id: "msg_amb" },
      })
      sendMessageMock.mockImplementation(async (a: { channel: string }) => {
        if (a.channel === "WHATSAPP") throw ambiguous
        return { id: "msg_1", status: "SENT" }
      })
      const r = await processPaymentReminders()
      expect(r.errors).toBe(0)
      expect(r.reconciliationRequired).toBe(1)
      expect(r.details.join("\n")).toContain("Held reminder_1d for L-001 via whatsapp; reconciliation required")
      expect(loanNoteCreateMock.mock.calls[0][0].data.note).toContain("delivery uncertain and held for reconciliation via whatsapp")
    })
  })

  it("triggers loan_overdue notification with data.amount = loan.arrearsAmount for an overdue trigger (WA vars fix)", async () => {
    loanFindManyMock.mockResolvedValue([loanOverdue3d()])
    triggerNotificationMock.mockResolvedValue(undefined)

    await processPaymentReminders()

    expect(triggerNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "loan_overdue",
        loanId: "loan_9",
        data: expect.objectContaining({ daysOverdue: 3, amount: 156_000 }),
      }),
    )
  })

  describe("sendMessage path", () => {
    // A channel that is ON but has no usable template is skipped for the tenant:
    // one warning each, logged and counted, never an abort and never an error.
    it("a tenant with no templates is not aborted: every enabled leg is skipped with a warning, no error", async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      messageTemplateFindFirstMock.mockResolvedValue(null)
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(loanFindManyMock).toHaveBeenCalled()
      expect(r.errors).toBe(0)
      // The SMS row, one WhatsApp row per trigger that has a WhatsApp leg, and the consumer and entity email rows.
      expect(r.warnings).toBe(1 + WA_TEMPLATE_EVENTS.length + 2)
      expect(r.details).toContainEqual(expect.stringMatching(/^Warning: sms legs skipped: payment_reminder_sms template missing\/inactive/))
      expect(warned).toHaveBeenCalledWith(expect.stringContaining("payment_reminder_sms template missing/inactive"))
      expect(sendMessageMock).not.toHaveBeenCalled()
      warned.mockRestore()
    })

    it("a missing SMS template skips only the SMS leg, with ONE warning; WhatsApp still sends", async () => {
      stubTemplates({ payment_reminder_sms: null })
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(r.errors).toBe(0)
      expect(r.warnings).toBe(1)
      expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["WHATSAPP"])
    })

    it("an SMS template with statutoryOverride=true is not used: the SMS leg is skipped with a warning", async () => {
      stubTemplates({ payment_reminder_sms: { ...sampleSmsTpl, statutoryOverride: true } })
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(r.errors).toBe(0)
      expect(r.warnings).toBe(1)
      expect(r.details).toContainEqual(expect.stringMatching(/statutoryOverride=true/))
      expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["WHATSAPP"])
    })

    it("SMS off (by policy): no SMS template is looked up, so its absence is no warning", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      stubTemplates({ payment_reminder_sms: null })
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      const keys = messageTemplateFindFirstMock.mock.calls.map((c) => c[0].where.key)
      expect(keys).not.toContain("payment_reminder_sms")
      expect(r.warnings).toBe(0)
      expect(r.errors).toBe(0)
      expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["WHATSAPP"])
    })

    describe("WhatsApp off (WA_ENABLED or the tenant's switch)", () => {
      const OFF = "WhatsApp disabled: WA_ENABLED is off"

      it("the leg is skipped BEFORE sendMessage: no send, no error, counted and reported once", async () => {
        waSwitch.refusal = OFF
        stubTemplates()
        loanFindManyMock.mockResolvedValue([loanDueIn(1), { ...loanDueIn(1), id: "loan_2", reference: "L-002" }])
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        const r = await processPaymentReminders()

        expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["SMS", "SMS"])
        expect(r.errors).toBe(0)
        expect(r.whatsappChannelOff).toBe(2)
        expect(r.details.filter((d) => d.includes("whatsapp leg(s)"))).toEqual([
          `Skipped 2 whatsapp leg(s) this run: ${OFF} (reminder_1d x2).`,
        ])
        // SMS still reached the borrower, so the note names SMS only.
        expect(loanNoteCreateMock.mock.calls[0][0].data.note).toContain("sent via sms")
        expect(loanNoteCreateMock.mock.calls[0][0].data.note).not.toContain("whatsapp")
      })

      it("no WhatsApp template is looked up, so a tenant without those rows gets no warning", async () => {
        waSwitch.refusal = OFF
        stubTemplates({ payment_reminder_1d_whatsapp: null })
        loanFindManyMock.mockResolvedValue([loanDueIn(1)])
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        const r = await processPaymentReminders()

        const keys = messageTemplateFindFirstMock.mock.calls.map((c) => c[0].where.key as string)
        expect(keys.filter((k) => k.endsWith("_whatsapp"))).toEqual([])
        expect(r.warnings).toBe(0)
        expect(r.errors).toBe(0)
      })

      it("SMS and WhatsApp both off: no SMS or WhatsApp template is looked up and nothing is sent", async () => {
        process.env.BULKSMS_DRY_RUN = "true"
        waSwitch.refusal = OFF
        stubTemplates()
        loanFindManyMock.mockResolvedValue([loanDueIn(1)])

        const r = await processPaymentReminders()

        const keys = messageTemplateFindFirstMock.mock.calls.map((c) => c[0].where.key as string)
        expect(keys, "only the email leg's rows (this borrower has no email address)").toEqual(["payment_reminder_email", "entity_reminder_email"])
        expect(sendMessageMock).not.toHaveBeenCalled()
        expect(loanNoteCreateMock).not.toHaveBeenCalled()
        expect(r.errors).toBe(0)
        expect(r.warnings).toBe(0)
        expect(r.details).toContainEqual(expect.stringContaining("1 borrower reminder(s) had NO leg dispatched this run (reminder_1d x1)"))
      })

      it("does not suppress loan_overdue's email at an overdue offset", async () => {
        waSwitch.refusal = OFF
        stubTemplates()
        loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
        triggerNotificationMock.mockResolvedValue(undefined)
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        await processPaymentReminders()

        expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
      })
    })

    it("routes through sendMessage for both channels", async () => {
      // Client has WA on file so the new path attempts both channels.
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(r.sent).toBe(1)
      expect(r.errors).toBe(0)
      expect(sendMessageMock).toHaveBeenCalledTimes(2)

      const smsCall = sendMessageMock.mock.calls.find((c) => c[0].channel === "SMS")
      expect(smsCall).toBeDefined()
      expect(smsCall![0].template.key).toBe("payment_reminder_sms")
      expect(smsCall![0].vars.body).toContain("L-001")
      expect(smsCall![0].toValue).toBe("27821234567") // normalised E.164
      expect(smsCall![0].category).toBe("collections")
      expect(smsCall![0].loanId).toBe("loan_1")

      const waCall = sendMessageMock.mock.calls.find((c) => c[0].channel === "WHATSAPP")
      expect(waCall).toBeDefined()
      expect(waCall![0].template.key).toBe("payment_reminder_1d_whatsapp")
      expect(waCall![0].toValue).toBe("27821234567@s.whatsapp.net")
    })

    it.each([
      [7, "reminder_7d", "payment_reminder_7d", { firstName: "Test", amount: "R 1,500.00", reference: "L-001" }],
      [1, "reminder_1d", "payment_reminder_1d", { amount: "R 1,500.00", reference: "L-001" }],
      [0, "reminder_0d", "payment_reminder_0d", { amount: "R 1,500.00", reference: "L-001", supportPhone: "+27 11 000 0001" }],
      [-1, "reminder_overdue_1d", "payment_reminder_overdue_1d", { amount: "R 1,500.00", reference: "L-001" }],
      [-3, "reminder_overdue_3d", "payment_reminder_overdue_3d", { outstanding: "R 1,560.00", reference: "L-001", supportPhone: "+27 11 000 0001" }],
    ] as const)(
      "daysUntilDue %i (%s): WhatsApp leg sends ITS OWN WABA template with named vars",
      async (days, _noteType, event, expected) => {
        loanFindManyMock.mockResolvedValue([loanDueIn(days)])
        triggerNotificationMock.mockResolvedValue(undefined) // overdue triggers also fire loan_overdue
        stubTemplates()
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        await processPaymentReminders()

        const waCall = sendMessageMock.mock.calls.find((c) => c[0].channel === "WHATSAPP")
        expect(waCall, "no WhatsApp send captured").toBeDefined()
        expect(waCall![0].template.key).toBe(`${event}_whatsapp`)
        const vars = waCall![0].vars as Record<string, string>
        expect(vars).toMatchObject(expected)
        // Every placeholder the registered body declares is supplied, and not
        // blank — send.ts drops the template (out-of-window: fails) otherwise,
        // and renderTemplate throws outright on an absent one.
        for (const p of extractPlaceholders(withSeededBrand(WABA_BODY_TEMPLATES[event], "Seeded Brand"))) {
          expect((vars[p] ?? "").trim(), `${event}: {{${p}}} not supplied`).not.toBe("")
        }

        // The SMS leg is untouched: still the shared passthrough row + {{body}}.
        const smsCall = sendMessageMock.mock.calls.find((c) => c[0].channel === "SMS")
        expect(smsCall![0].template.key).toBe("payment_reminder_sms")
        expect(smsCall![0].vars.body).toContain("L-001")
      },
    )

    it("every WhatsApp trigger names a WABA template that has a registered body", () => {
      for (const t of TRIGGERS.filter((t) => t.channels.includes("whatsapp"))) {
        expect(t.waTemplateEvent, `${t.noteType} has a whatsapp leg but no template`).toBeDefined()
        expect(WABA_BODY_TEMPLATES[t.waTemplateEvent!], `${t.noteType}: no body`).toBeDefined()
      }
    })

    // A per-trigger WhatsApp row that is missing (or inactive — findFirst
    // filters active:true, so the two are one case) or statutory blocks ONLY
    // that trigger's WhatsApp leg. The SMS leg is the one channel that must
    // never be taken down by a WhatsApp-template problem — e.g. code deployed
    // before the migration that seeds these rows.
    it.each([
      ["missing/inactive", { payment_reminder_overdue_3d_whatsapp: null }, /Warning: whatsapp reminder_overdue_3d legs skipped: template payment_reminder_overdue_3d_whatsapp missing\/inactive/],
      [
        "statutoryOverride=true",
        { payment_reminder_overdue_3d_whatsapp: { ...waTpl("payment_reminder_overdue_3d"), statutoryOverride: true } },
        /Warning: whatsapp reminder_overdue_3d legs skipped: template payment_reminder_overdue_3d_whatsapp has statutoryOverride=true/,
      ],
    ] as const)("%s per-trigger WhatsApp row blocks only that WhatsApp leg; the SMS leg still sends", async (_label, overrides, detail) => {
      loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
      triggerNotificationMock.mockResolvedValue(undefined)
      stubTemplates(overrides as Record<string, unknown>)
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(loanFindManyMock).toHaveBeenCalled() // cron not aborted
      const channels = sendMessageMock.mock.calls.map((c) => c[0].channel)
      expect(channels).toEqual(["SMS"])
      expect(r.sent).toBe(1)
      expect(r.errors).toBe(0) // a setup gap, not a send fault
      expect(r.warnings).toBe(1) // visible, not silent: one tenant-level warning
      expect(r.details).toContainEqual(expect.stringMatching(detail))
      expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ note: expect.stringContaining("Automated reminder sent via sms") }),
      }))
    })

    it("a missing per-trigger WhatsApp row is no error for a client with no WhatsApp on file", async () => {
      loanFindManyMock.mockResolvedValue([{ ...loanDueIn(0), client: { ...loanDueTomorrow().client, whatsapp: null } }])
      stubTemplates({ payment_reminder_0d_whatsapp: null })
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(r.errors).toBe(0)
      expect(r.sent).toBe(1)
      expect(r.details).toContainEqual(
        expect.stringContaining("Skipped 1 whatsapp leg(s) this run: no WhatsApp number on file (reminder_0d x1)"),
      )
    })

    it("the LoanNote quotes what EACH channel sent — the WhatsApp leg's rendered body, not the SMS text", async () => {
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      await processPaymentReminders()

      const note = loanNoteCreateMock.mock.calls[0][0].data.note as string
      // SMS: the TRIGGERS copy, lender name from the tenant's identity.
      expect(note).toMatch(/sms: "Reminder: R 1,500\.00 due TOMORROW \(.+\) on loan L-001\. Please ensure funds are available\. Acme Lending"/)
      // WhatsApp: the seeded row body, rendered with the vars actually sent.
      expect(note).toMatch(/whatsapp: "Reminder: R 1,500\.00 due TOMORROW \(.+\) on loan L-001\. Please ensure funds are available\. Seeded Brand"/)
    })

    it("records new-pipeline dry-runs as simulated, never sent", async () => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockResolvedValue({ id: "msg_sim", status: "SIMULATED" })

      const r = await processPaymentReminders()

      expect(r.sent).toBe(0)
      expect(r.simulated).toBe(1)
      expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ note: expect.stringContaining("simulated (not sent)") }),
      }))
    })

    it.each(["FAILED", "FAILED_PERMANENT", "EXPIRED", "BOUNCED"] as const)(
      "surfaces terminal %s reservations as failures, never pending",
      async (status) => {
        stubTemplates()
        lookupContactMock.mockResolvedValue({ id: "ct_1" })
        sendMessageMock.mockResolvedValue({ id: "msg_terminal", status })

        const r = await processPaymentReminders()

        expect(r.sent).toBe(0)
        expect(r.errors).toBe(1)
        expect(r.details).toContainEqual(expect.stringContaining(`${status})`))
        expect(r.details).toContainEqual(expect.stringContaining("operator action required"))
        expect(r.details).not.toContainEqual(expect.stringContaining("reservation already active"))
      },
    )

    it("surfaces consent-suppressed reservations as terminal not-sent outcomes", async () => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockResolvedValue({ id: "msg_suppressed", status: "SUPPRESSED_BY_CONSENT" })

      const r = await processPaymentReminders()

      expect(r.sent).toBe(0)
      expect(r.errors).toBe(0)
      expect(r.details).toContainEqual(expect.stringContaining("consent suppression is terminal"))
      expect(r.details).not.toContainEqual(expect.stringContaining("reservation already active"))
    })

    it("hoists template lookups once per cron run (not per loan)", async () => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      const withWa = (id: string, ref: string) => {
        const l = loanDueTomorrow()
        l.id = id
        l.reference = ref
        l.client.whatsapp = "0821234567"
        return l
      }
      loanFindManyMock.mockResolvedValue([
        withWa("loan_1", "L-001"),
        withWa("loan_2", "L-002"),
        withWa("loan_3", "L-003"),
      ])

      await processPaymentReminders()

      // One SMS + one per WhatsApp trigger (+ one per successor body), regardless
      // of loan count. Counted from TRIGGERS so adding a WhatsApp leg does not
      // silently turn this into a per-loan-lookup regression test that passes by arithmetic.
      const successors = TRIGGERS.filter((t) => t.waTemplateSuccessor).length
      expect(messageTemplateFindFirstMock).toHaveBeenCalledTimes(3 + WA_TEMPLATE_EVENTS.length + successors)
      expect(sendMessageMock).toHaveBeenCalledTimes(6) // 3 loans × 2 channels
    })

    it("missing SMS Contact = error; missing WhatsApp number (whatsapp=null) = silent Skip", async () => {
      // Default fixture: loan.client.whatsapp = null. SMS lookup returns
      // null (no ContactIdentity) → error. WhatsApp leg silently skips
      // because the client has no WhatsApp on file (opportunistic policy
      // — fallback to phone would generate "no Contact row" noise for
      // every legacy client).
      stubTemplates()
      lookupContactMock.mockResolvedValue(null)

      const r = await processPaymentReminders()

      expect(r.sent).toBe(0)
      expect(r.errors).toBe(1) // SMS only
      expect(r.details).toContainEqual("Error L-001 sms: no Contact row")
      expect(JSON.stringify(r.details), "no phone number in the report").not.toMatch(/2782\d{7}/)
      expect(r.details).toContainEqual(
        expect.stringContaining("Skipped 1 whatsapp leg(s) this run: no WhatsApp number on file (reminder_1d x1)"),
      )
      // SMS errored and WhatsApp had no number: neither leg was dispatched.
      expect(r.details).toContainEqual(
        expect.stringContaining("1 borrower reminder(s) had NO leg dispatched this run (reminder_1d x1)"),
      )
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
    })

    it("both legs fail by FAULT: no policy skip at all, but the trigger is still counted as having dispatched nothing", async () => {
      // SMS channel ON, client HAS a WhatsApp number — so neither the SMS-off
      // skip nor the no-WhatsApp-number skip fires. Both Contact lookups miss
      // (data drift), so both legs error and nothing is dispatched. An earlier
      // draft required a policy skip before counting, and silently left this
      // borrower out of the count.
      process.env.BULKSMS_DRY_RUN = "false"
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0827654321"
      loanFindManyMock.mockResolvedValue([loanWithWa])
      stubTemplates()
      lookupContactMock.mockResolvedValue(null)

      const r = await processPaymentReminders()

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
      expect(r.errors).toBe(2) // both legs
      expect(r.smsChannelOff).toBe(0)
      expect(r.details.some((d) => d.includes("no WhatsApp number on file"))).toBe(false)
      expect(r.details).toContainEqual(
        expect.stringContaining("1 borrower reminder(s) had NO leg dispatched this run (reminder_1d x1)"),
      )
    })

    it("client WITH whatsapp number — missing Contact for WA = error, NOT silent (fail-loud preserved when WA is opted-in)", async () => {
      // When the client HAS a whatsapp number on file, the operator's
      // intent is clearly to send via WA. Missing ContactIdentity is data
      // drift — surface it loudly.
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0827654321"
      loanFindManyMock.mockResolvedValue([loanWithWa])
      stubTemplates()
      lookupContactMock.mockResolvedValue(null)

      const r = await processPaymentReminders()

      expect(r.errors).toBe(2) // SMS + WA both error
      expect(r.details).toContainEqual("Error L-001 whatsapp: no Contact row")
      expect(JSON.stringify(r.details), "no WhatsApp number in the report").not.toMatch(/2782\d{7}/)
    })

    it("SendBlockedError = skip (correct behavior), NOT error", async () => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      sendMessageMock.mockRejectedValue(new SendBlockedError("BLOCKED"))

      const r = await processPaymentReminders()

      expect(r.sent).toBe(0)
      expect(r.errors).toBe(0) // blocked != error
      expect(r.details.some((d) => d.startsWith("Skip "))).toBe(true)
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
    })

    it("unparseable phone = per-channel error", async () => {
      stubTemplates()
      loanFindManyMock.mockResolvedValue([
        { ...loanDueTomorrow(), client: { ...loanDueTomorrow().client, phone: "not-a-phone" } },
      ])

      const r = await processPaymentReminders()

      expect(r.errors).toBeGreaterThanOrEqual(1)
      expect(r.details).toContainEqual("Error L-001 sms: unparseable phone number")
      expect(JSON.stringify(r.details), "the bad value stays out of the report").not.toContain("not-a-phone")
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it("an email that cannot be normalised or has no Contact row is reported as an EMAIL problem, without the address", async () => {
      stubTemplates()
      lookupContactMock.mockResolvedValue(null)
      const loan = loanDueIn(7)
      loanFindManyMock.mockResolvedValue([{ ...loan, client: { ...loan.client, email: "borrower@client.invalid" } }])
      const r = await processPaymentReminders()
      expect(r.details).toContainEqual("Error L-001 email: no Contact row")
      expect(JSON.stringify(r.details)).not.toContain("borrower@client.invalid")
    })
  })

  // With BULKSMS_DRY_RUN=true SMS is off. Every SMS leg here used to
  // dispatch anyway, land a SIMULATED Message row, and write a LoanNote
  // reading "Automated reminder simulated (not sent) via sms: ..." — a loan
  // record that looks like the borrower was contacted when nothing was sent.
  // ── duplicate dunning ──────────────────────────────────────────────────
  //
  // The cron fires loan_overdue for every trigger with daysUntilDue < 0. At
  // -1 and -3 those offsets have their OWN reminder stage, and both that
  // stage and loan_overdue render on WhatsApp — two dunning WhatsApps the
  // same morning. The cron asks for loan_overdue's WhatsApp leg to be
  // dropped at exactly those offsets, and only that leg: loan_overdue also
  // carries the overdue EMAIL, which no reminder stage sends.
  describe("duplicate dunning", () => {
    it("asks for suppression when the trigger has a WhatsApp leg, and not otherwise", () => {
      // Tested against synthetic triggers, not TRIGGERS: every negative
      // offset currently HAS a WhatsApp leg, so a TRIGGERS-only test cannot
      // tell a derived rule from a hardcoded `true`.
      expect(
        overdueWhatsAppSuppressionReason({ noteType: "reminder_overdue_1d", channels: ["sms", "whatsapp"] }),
      ).toMatch(/reminder_overdue_1d/)
      expect(
        overdueWhatsAppSuppressionReason({ noteType: "reminder_overdue_1d", channels: ["sms"] }),
      ).toBeUndefined()
    })

    it.each([[-1, "reminder_overdue_1d"], [-3, "reminder_overdue_3d"]] as const)(
      "daysUntilDue %i (%s): loan_overdue fires, but its WhatsApp leg is suppressed by reason",
      async (days, noteType) => {
        loanFindManyMock.mockResolvedValue([loanDueIn(days)])
        triggerNotificationMock.mockResolvedValue(undefined)
        stubTemplates()
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        await processPaymentReminders()

        expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
        const call = triggerNotificationMock.mock.calls[0][0]
        expect(call.event).toBe("loan_overdue")
        // The EVENT still fires — the overdue email must not be lost.
        expect(call.suppressWhatsAppReason).toEqual(expect.stringContaining(noteType))
      },
    )

    it("exactly ONE dunning WhatsApp per borrower per day at an overdue offset", async () => {
      // The reminder stage's own WhatsApp is the one that goes out; the
      // loan_overdue leg is the one suppressed.
      loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
      triggerNotificationMock.mockResolvedValue(undefined)
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      await processPaymentReminders()

      const waSends = sendMessageMock.mock.calls.filter((c) => c[0].channel === "WHATSAPP")
      expect(waSends).toHaveLength(1)
      expect(waSends[0][0].template.key).toBe("payment_reminder_overdue_3d_whatsapp")
      expect(triggerNotificationMock.mock.calls[0][0].suppressWhatsAppReason).toBeTruthy()
    })

    it("a NON-overdue offset does not fire loan_overdue at all", async () => {
      // Unchanged behaviour: the event is only fired for daysUntilDue < 0.
      for (const days of [7, 1, 0]) {
        triggerNotificationMock.mockClear()
        loanFindManyMock.mockResolvedValue([loanDueIn(days)])
        stubTemplates()
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        await processPaymentReminders()

        expect(triggerNotificationMock, `daysUntilDue ${days}`).not.toHaveBeenCalled()
      }
    })
  })

  describe("SMS CHANNEL OFF (BULKSMS_DRY_RUN=true)", () => {
    afterEach(() => {
      process.env.BULKSMS_DRY_RUN = "false"
    })

    it("sendMessage is never called with channel SMS; WhatsApp unaffected", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["WHATSAPP"])
      expect(r.errors).toBe(0)
      expect(r.simulated).toBe(0)
    })

    // SMS off AND no WhatsApp number on file: nothing was carried, so the note
    // must be ABSENT — not an empty or channel-less "Automated reminder ..."
    // line. (New-send path: a client without a WhatsApp number is a real skip.)
    it("a trigger with no reachable channel writes NO LoanNote at all", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      stubTemplates()
      const sevenDays = sastDayOffset(7)
      loanFindManyMock.mockResolvedValue([
        { ...loanDueTomorrow(), nextPaymentDate: sevenDays },
      ])

      const r = await processPaymentReminders()

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(loanNoteCreateMock).not.toHaveBeenCalled()
      expect(r.sent).toBe(0)
      expect(r.simulated).toBe(0)
      expect(r.errors).toBe(0)
      expect(r.smsChannelOff).toBe(1)
      expect(r.details).toContainEqual(
        expect.stringContaining("reminder_7d x1"),
      )
      // Every trigger now carries a WhatsApp leg, so the run must NOT claim
      // these borrowers were unreachable BECAUSE the trigger is SMS-only. That
      // claim is computed from TRIGGERS, so it comes back the moment a trigger
      // loses its WhatsApp leg.
      expect(r.details.some((d) => d.includes("not reminded at all"))).toBe(false)
      // It must still say, plainly, that nothing was dispatched for this
      // borrower: SMS blocked AND no WhatsApp number on file.
      expect(r.details).toContainEqual(
        expect.stringContaining("Skipped 1 whatsapp leg(s) this run: no WhatsApp number on file (reminder_7d x1)"),
      )
      expect(r.details).toContainEqual(
        expect.stringContaining("1 borrower reminder(s) had NO leg dispatched this run (reminder_7d x1)"),
      )
    })

    // The two triggers this PR gave a WhatsApp leg. With SMS off they must
    // still reach a borrower who has WhatsApp on file, and the LoanNote must
    // name WhatsApp — and only WhatsApp.
    it.each([
      [7, "reminder_7d", "payment_reminder_7d_whatsapp"],
      [-1, "reminder_overdue_1d", "payment_reminder_overdue_1d_whatsapp"],
    ] as const)(
      "SMS off, daysUntilDue %i (%s): the WhatsApp leg still sends and the note names WhatsApp only",
      async (days, noteType, key) => {
        process.env.BULKSMS_DRY_RUN = "true"
          loanFindManyMock.mockResolvedValue([loanDueIn(days)])
        triggerNotificationMock.mockResolvedValue(undefined)
        stubTemplates()
        lookupContactMock.mockResolvedValue({ id: "ct_1" })

        const r = await processPaymentReminders()

        expect(sendMessageMock.mock.calls.map((c) => c[0].channel)).toEqual(["WHATSAPP"])
        expect(sendMessageMock.mock.calls[0][0].template.key).toBe(key)
        expect(r.sent).toBe(1)
        expect(r.errors).toBe(0)
        expect(r.smsChannelOff).toBe(1)

        // WhatsApp was dispatched, so this trigger is not counted as
        // "no leg dispatched" — even though the SMS leg was blocked.
        expect(r.details.some((d) => d.includes("NO leg dispatched"))).toBe(false)

        const note = loanNoteCreateMock.mock.calls[0][0].data
        expect(note.type).toBe(noteType)
        expect(note.note).toContain("sent via whatsapp")
        expect(note.note).not.toContain("sms")
        // The note quotes what WhatsApp actually carried — the WABA body, not
        // the SMS copy. Both literals below are written out here on purpose:
        // deriving either from WABA_BODY_TEMPLATES would make this assertion
        // agree with whatever the module says, including a mistake.
        expect(note.note).not.toContain("Reply STOP to opt out.")
        expect(note.note).toContain(
          days === 7
            ? "Hi Test, your loan payment of R 1,500.00 is due on"
            : "URGENT: Your payment of R 1,500.00 on loan L-001 was due yesterday.",
        )
      },
    )

    // SMS back on: both legs run for the two new WhatsApp triggers.
    it.each([
      [7, "reminder_7d"],
      [-1, "reminder_overdue_1d"],
    ] as const)("SMS on, daysUntilDue %i (%s): BOTH legs run", async (days, _noteType) => {
      process.env.BULKSMS_DRY_RUN = "false"
      loanFindManyMock.mockResolvedValue([loanDueIn(days)])
      triggerNotificationMock.mockResolvedValue(undefined)
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(sendMessageMock.mock.calls.map((c) => c[0].channel).sort()).toEqual(["SMS", "WHATSAPP"])
      expect(r.smsChannelOff).toBe(0)
      expect(r.errors).toBe(0)
      const note = loanNoteCreateMock.mock.calls[0][0].data.note as string
      expect(note).toContain("sent via sms+whatsapp")
    })

    // The skip writes no LoanNote (there was no contact to record), so
    // alreadyProcessedToday() cannot suppress it next tick. One aggregate
    // line per RUN keeps that bounded — a line per loan would reprint for
    // every matching loan on every tick for as long as SMS stays off.
    it("reports ONE aggregate line per run, not one per loan", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      const sevenDays = sastDayOffset(7)
      loanFindManyMock.mockResolvedValue([
        { ...loanDueTomorrow(), id: "l1", reference: "L-001", nextPaymentDate: sevenDays },
        { ...loanDueTomorrow(), id: "l2", reference: "L-002", nextPaymentDate: sevenDays },
        { ...loanDueTomorrow(), id: "l3", reference: "L-003", nextPaymentDate: sevenDays },
      ])

      const r = await processPaymentReminders()

      expect(r.smsChannelOff).toBe(3)
      const offLines = r.details.filter((d) => d.includes("SMS not enabled"))
      expect(offLines).toHaveLength(1)
      expect(offLines[0]).toContain("Blocked 3 sms leg(s)")
      expect(offLines[0]).toContain("reminder_7d x3")
      // No per-loan spam FOR ANY skip: each accounting line is one per run,
      // however many loans matched. Three loans, three of each skip, one line.
      expect(r.details.filter((d) => d.includes("sms leg(s)"))).toHaveLength(1)
      expect(r.details.filter((d) => d.includes("whatsapp leg(s)"))).toHaveLength(1)
      expect(r.details.filter((d) => d.includes("NO leg dispatched"))).toHaveLength(1)
      expect(r.details).toContainEqual(
        expect.stringContaining("3 borrower reminder(s) had NO leg dispatched this run (reminder_7d x3)"),
      )
      expect(r.details.some((d) => d.includes("L-002"))).toBe(false)
    })
  })
})

// Default charges. What the
// borrower must pay now is the schedule amount PLUS the default charges
// outstanding, so every figure a reminder quotes carries them. Flag off, the
// charges are 0 and every message is byte-identical to before.
describe("default charges in reminder amounts", () => {
  beforeEach(() => {
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    triggerNotificationMock.mockResolvedValue(undefined)
  })

  const sent = (channel: "SMS" | "WHATSAPP") =>
    sendMessageMock.mock.calls.find((c) => c[0].channel === channel)![0]

  it("asks for the charges owed today, for this loan, in this tenant", async () => {
    loanFindManyMock.mockResolvedValue([loanDueIn(-3)])

    await processPaymentReminders()

    expect(chargesOutstandingAtMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant_acme", loanId: "loan_1" },
      expect.any(Date),
    )
  })

  it("3 days overdue: SMS, WhatsApp and loan_overdue quote arrears + charges", async () => {
    chargesOutstandingAtMock.mockResolvedValue(23_450)
    loanFindManyMock.mockResolvedValue([loanDueIn(-3)])

    await processPaymentReminders()

    // 156_000 arrears + 23_450 charges = 179_450
    expect(sent("SMS").vars.body).toContain("Outstanding: R 1,794.50.")
    expect(sent("WHATSAPP").vars.outstanding).toBe("R 1,794.50")
    expect(triggerNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "loan_overdue",
        data: expect.objectContaining({ amount: 179_450 }),
      }),
    )
  })

  it("due today: the instalment amount quoted includes the charges", async () => {
    chargesOutstandingAtMock.mockResolvedValue(23_450)
    loanFindManyMock.mockResolvedValue([loanDueIn(0)])

    await processPaymentReminders()

    // 150_000 instalment + 23_450 charges = 173_450
    expect(sent("SMS").vars.body).toContain("Your loan payment of R 1,734.50 is due today.")
    expect(sent("WHATSAPP").vars.amount).toBe("R 1,734.50")
  })

  it("flag off (real helper): amounts are unchanged", async () => {
    const real = await vi.importActual<typeof import("@/lib/loan/charges-replay")>(
      "@/lib/loan/charges-replay",
    )
    chargesOutstandingAtMock.mockImplementation(real.chargesOutstandingAt)
    loanFindUniqueMock.mockResolvedValue({
      tenant: {
        config: {
          defaultChargesEnabled: false,
          defaultChargesStartedAt: null,
          defaultAdminChargeCents: 8200,
          defaultAdminPostageCents: 0,
        },
      },
    })
    loanFindManyMock.mockResolvedValue([loanDueIn(-3)])

    await processPaymentReminders()

    expect(loanFindUniqueMock).toHaveBeenCalled()
    expect(sent("SMS").vars.body).toContain("Outstanding: R 1,560.00.")
    expect(sent("WHATSAPP").vars.outstanding).toBe("R 1,560.00")
    expect(triggerNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 156_000 }) }),
    )
  })
})

describe("reminder_0d wording", () => {
  it("states the amount and reference on the due day without threatening charges", () => {
    const msg = TRIGGERS.find((t) => t.noteType === "reminder_0d")!.getMessage({
      firstName: "Thabo",
      amount: "R 1,500.00",
      date: "15 Jul 2026",
      loanRef: "LN-0099",
      arrearsAmount: "R 1,500.00",
      lenderName: "Acme",
      phone: "+27 11 000 0000",
    })
    expect(msg).toBe(
      "Your loan payment of R 1,500.00 is due today. Ref: LN-0099. Need help? Contact Acme on +27 11 000 0000.",
    )
    expect(msg).not.toMatch(/avoid|default interest|charges|late fee/i)
  })
})

// #141 review: the due-day WhatsApp body still threatened ("avoid late fees").
// v3 is neutral; a tenant moves to it only once Meta has APPROVED it, so no
// tenant is silently switched off the template Meta approved for it.
describe("due-day WhatsApp template v3", () => {
  beforeEach(() => {
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([loanDueIn(0)])
  })
  const waKey = () => sendMessageMock.mock.calls.find((c) => c[0].channel === "WHATSAPP")?.[0].template.key

  it("sends v3 once Meta has approved it", async () => {
    stubTemplates({ payment_reminder_0d_v3_whatsapp: { ...waTpl("payment_reminder_0d_v3"), providerStatus: "APPROVED" } })
    await processPaymentReminders()
    expect(waKey()).toBe("payment_reminder_0d_v3_whatsapp")
  })

  it("keeps the approved v1 while v3 is pending or absent", async () => {
    stubTemplates({ payment_reminder_0d_v3_whatsapp: { ...waTpl("payment_reminder_0d_v3"), providerStatus: "PENDING" } })
    await processPaymentReminders()
    expect(waKey()).toBe("payment_reminder_0d_whatsapp")
    sendMessageMock.mockClear()
    stubTemplates()
    await processPaymentReminders()
    expect(waKey()).toBe("payment_reminder_0d_whatsapp")
  })
})

describe("Kabelo-shaped schedule (every unpaid row stored PARTIAL)", () => {
  // Answers the cron's next-instalment query the way Postgres would: status
  // filter, positive total, earliest due date first.
  function answerFrom(rows: ReturnType<typeof kabeloScheduleAsAudited>) {
    repaymentScheduleFindFirstMock.mockImplementation(
      async (a: { where: { status: { in: string[] } } }) =>
        rows
          .filter((r) => a.where.status.in.includes(r.status) && r.totalDue > 0)
          .sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime())[0] ?? null,
    )
  }

  afterEach(() => vi.useRealTimers())

  it("quotes the instalment actually due, never R 0.00", async () => {
    const rows = kabeloScheduleAsAudited()
    vi.useFakeTimers({ toFake: ["Date"] })
    // 7 days before #4 (1 Jun 2026).
    vi.setSystemTime(new Date("2026-05-25T08:00:00.000Z"))
    answerFrom(rows)
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([{
      ...loanDueTomorrow(), nextPaymentDate: rows[3].dueDate,
      client: { ...loanDueTomorrow().client, whatsapp: "0821234567" },
    }])

    await processPaymentReminders()

    const sms = sendMessageMock.mock.calls.find((c) => c[0].channel === "SMS")?.[0] as { vars: { body: string } } | undefined
    expect(sms?.vars.body).toContain("your loan payment of R 2,253.75 is due on")
    expect(sms?.vars.body).not.toContain("R 0.00")
  })

  it("sends nothing when nothing is owed on the schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-05-25T08:00:00.000Z"))
    const paidUp = kabeloScheduleAsAudited().map((r) => ({ ...r, totalPaid: r.totalDue, status: "PAID" as const }))
    answerFrom(paidUp)
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([{ ...loanDueTomorrow(), nextPaymentDate: paidUp[3].dueDate }])

    const r = await processPaymentReminders()

    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(r.details).toContainEqual(expect.stringContaining("nothing owed"))
  })
})

describe("reminder date in SAST", () => {
  afterEach(() => vi.useRealTimers())

  // A due date stored at SAST midnight is 22:00 UTC the day before. Formatted
  // in the container's zone it printed a day early in every reminder.
  it("prints a SAST-midnight due date as that SAST day, not the UTC day before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-08-19T06:00:00.000Z"))
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([{ ...loanDueTomorrow(), nextPaymentDate: new Date("2026-08-19T22:00:00.000Z") }])

    await processPaymentReminders()

    const sms = sendMessageMock.mock.calls.find((c) => c[0].channel === "SMS")![0] as { vars: { body: string } }
    expect(sms.vars.body).toContain("20 Aug 2026")
    expect(sms.vars.body).not.toContain("19 Aug 2026")
  })
})

describe("loan_overdue from an overdue reminder", () => {
  afterEach(() => {
    process.env.BULKSMS_DRY_RUN = "false"
  })
  // Every leg skipped: SMS off and no WhatsApp number, so no reminder LoanNote.
  function noLegReaches() {
    process.env.BULKSMS_DRY_RUN = "true"
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([loanOverdue3d()])
    triggerNotificationMock.mockResolvedValue(undefined)
  }
  // The reservation and note stores the cron reads back, so a second run sees what the first left.
  function stores() {
    const reserved = new Set<string>()
    reserveOnceMock.mockImplementation(async (_tenantId: string, key: string) => {
      if (reserved.has(key)) return false
      reserved.add(key)
      return true
    })
    releaseReservationMock.mockImplementation(async (key: string) => {
      reserved.delete(key)
    })
    const notes: Array<{ loanId: string; type: string }> = []
    loanNoteCreateMock.mockImplementation(async (a: { data: { loanId: string; type: string } }) => {
      notes.push({ loanId: a.data.loanId, type: a.data.type })
      return { id: `note_${notes.length}` }
    })
    loanNoteFindFirstMock.mockImplementation(async (a: { where: { loanId: string; type: string } }) =>
      notes.find((n) => n.loanId === a.where.loanId && n.type === a.where.type) ?? null)
    return { reserved, notes }
  }
  const KEY = "send:loan_9:reminder_overdue_3d:loan_overdue"

  it("fires once per loan per SAST day even when no reminder leg wrote a LoanNote", async () => {
    noLegReaches()
    const { reserved, notes } = stores()

    await processPaymentReminders()
    const second = await processPaymentReminders()

    expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    expect([...reserved]).toEqual([KEY])
    expect(notes, "the reservation is the record, not a note").toEqual([])
    expect(second.details).toContainEqual("Skip L-009: loan_overdue for reminder_overdue_3d already fired today")
  })

  it("reserves before it fires, and keeps the reservation when the notification went", async () => {
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
    triggerNotificationMock.mockResolvedValue(undefined)
    const { notes } = stores()

    await processPaymentReminders()
    await processPaymentReminders()

    expect(reserveOnceMock).toHaveBeenCalledWith("tenant_acme", "send:loan_1:reminder_overdue_3d:loan_overdue", expect.any(Date))
    expect(releaseReservationMock).not.toHaveBeenCalled()
    expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    expect(notes.map((n) => n.type)).toEqual(["reminder_overdue_3d"])
  })

  it("a notification that throws is logged and counted, not swallowed, gives its reservation back, and is retried next run", async () => {
    noLegReaches()
    const { reserved } = stores()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    triggerNotificationMock.mockRejectedValueOnce(new Error("mail relay down"))

    const first = await processPaymentReminders()

    expect(first.errors).toBe(1)
    expect(first.failedTenants).toBe(0)
    // Generic in the body; the cause is in the log only.
    expect(first.details).toContainEqual("Error L-009 loan_overdue: failed; see the server log")
    expect(JSON.stringify(first.details)).not.toContain("mail relay down")
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("L-009 loan_overdue failed"), expect.objectContaining({ message: "mail relay down" }))
    // Against the day it was taken: the very instant it was reserved at.
    expect(releaseReservationMock).toHaveBeenCalledWith(KEY, reserveOnceMock.mock.calls[0][2])
    expect([...reserved]).toEqual([])

    const second = await processPaymentReminders()
    expect(second.errors).toBe(0)
    expect(triggerNotificationMock).toHaveBeenCalledTimes(2)
    expect([...reserved]).toEqual([KEY])
    logged.mockRestore()
  })

  it("a database fault in the notification fails the tenant, so the run is retried", async () => {
    noLegReaches()
    stores()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    triggerNotificationMock.mockRejectedValueOnce(new Prisma.PrismaClientInitializationError("can't reach", "5.22.0"))

    const r = await processPaymentReminders()

    expect(r.failedTenants).toBe(1)
    expect(releaseReservationMock).toHaveBeenCalledWith(KEY, expect.any(Date))
  })

  it("a leg the notification reports as failed is counted, gives its reservation back, and the next run tries again", async () => {
    noLegReaches()
    const { reserved } = stores()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    triggerNotificationMock.mockResolvedValueOnce({ failedLegs: ["email"] }).mockResolvedValue({ failedLegs: [] })

    const first = await processPaymentReminders()

    expect(first.errors).toBe(1)
    expect(first.details).toContainEqual("Error L-009 loan_overdue: email failed; see the notification log")
    expect([...reserved], "not left looking done").toEqual([])

    const second = await processPaymentReminders()
    expect(second.errors).toBe(0)
    expect(triggerNotificationMock).toHaveBeenCalledTimes(2)
    expect([...reserved]).toEqual([KEY])
  })

  it("if giving the reservation back fails too, the notification's own failure is what is reported", async () => {
    noLegReaches()
    stores()
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    releaseReservationMock.mockRejectedValue(new Error("release failed"))
    triggerNotificationMock.mockRejectedValueOnce(new Error("mail relay down"))

    const r = await processPaymentReminders()

    expect(r.failedTenants).toBe(0)
    expect(r.errors).toBe(1)
    expect(r.details).toContainEqual("Error L-009 loan_overdue: failed; see the server log")
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("could not give the reservation back"), expect.objectContaining({ message: "release failed" }))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("L-009 loan_overdue failed"), expect.objectContaining({ message: "mail relay down" }))
  })

  // A debt-review notice recorded while the trigger's own legs are in flight (a slow provider)
  // must stop the loan_overdue notice that follows them.
  it("a hold recorded while the trigger's legs are in flight stops the loan_overdue, and gives its reservation back", async () => {
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
    triggerNotificationMock.mockResolvedValue({ failedLegs: [] })
    sendMessageMock.mockImplementation(async () => {
      holds.held = true
      return { id: "m", status: "SENT" }
    })
    try {
      const r = await processPaymentReminders()
      expect(sendMessageMock).toHaveBeenCalled()
      expect(triggerNotificationMock).not.toHaveBeenCalled()
      expect(releaseReservationMock).toHaveBeenCalledWith("send:loan_1:reminder_overdue_3d:loan_overdue", expect.any(Date))
      expect(r.details).toContainEqual(expect.stringContaining("Skip L-001: loan_overdue for reminder_overdue_3d, the loan stopped being ACTIVE or was put on a dunning hold"))
    } finally {
      holds.held = false
    }
  })

  // The trigger's LoanNote stops its own legs from going twice; it must not also stop a
  // loan_overdue that failed earlier today (and gave its reservation back) from being retried.
  describe("an overdue trigger already reminded today", () => {
    beforeEach(() => {
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })
      loanNoteFindFirstMock.mockResolvedValue({ id: "note_today" })
      triggerNotificationMock.mockResolvedValue({ failedLegs: [] })
    })
    afterEach(() => {
      holds.held = false
    })

    it("sends no leg again but still fires its loan_overdue, under the reservation", async () => {
      loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
      const r = await processPaymentReminders()
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(r.details).toContainEqual("Skip L-001: reminder_overdue_3d already processed today")
      expect(reserveOnceMock).toHaveBeenCalledWith("tenant_acme", "send:loan_1:reminder_overdue_3d:loan_overdue", expect.any(Date))
      expect(triggerNotificationMock).toHaveBeenCalledTimes(1)
    })

    it("a pre-due trigger already processed does nothing more", async () => {
      loanFindManyMock.mockResolvedValue([loanDueIn(1)])
      await processPaymentReminders()
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(reserveOnceMock).not.toHaveBeenCalled()
      expect(triggerNotificationMock).not.toHaveBeenCalled()
    })

    it("a loan put on hold since fires nothing", async () => {
      holds.held = true
      loanFindManyMock.mockResolvedValue([loanDueIn(-3)])
      await processPaymentReminders()
      expect(triggerNotificationMock).not.toHaveBeenCalled()
    })
  })
})

describe("review round 1: reminders cron", () => {
  const legChannels = () => sendMessageMock.mock.calls.map((c) => (c[0] as { channel: string }).channel)
  beforeEach(() => {
    stubTemplates()
    lookupContactMock.mockResolvedValue({ id: "ct_1" })
    loanFindManyMock.mockResolvedValue([loanDueIn(1)])
  })

  // The borrower's WhatsApp number was edited to one a lead (or another client) holds: the lookup
  // resolves THEIR Contact, whose consent is not the borrower's and who must not read this loan.
  it("a leg whose Contact is someone else's is refused, counted, and the report names no number", async () => {
    lookupContactMock.mockImplementation(async (_db: unknown, a: { channel: string }) =>
      a.channel === "WHATSAPP" ? { id: "ct_lead", clientId: null } : { id: "ct_1" })

    const r = await processPaymentReminders()

    expect(legChannels()).toEqual(["SMS"])
    expect(r.errors).toBe(1)
    expect(r.details).toContainEqual("Error L-001 whatsapp: the Contact for this phone number belongs to someone else; not sent")
    expect(JSON.stringify(r.details)).not.toMatch(/0821234567|27821234567/)
    expect(loanNoteCreateMock.mock.calls[0][0].data.note).not.toContain("whatsapp")
  })

  it("a WhatsApp settings row that cannot be read fails the tenant, so it is retried, instead of skipping WhatsApp as off", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    waSwitch.refusal = WA_SETTINGS_UNAVAILABLE_REASON

    const r = await processPaymentReminders()

    expect(r).toMatchObject({ failedTenants: 1, whatsappChannelOff: 0 })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("a row this run created that the provider refused for now is 'retry scheduled': not a duplicate, not an error", async () => {
    sendMessageMock.mockImplementation(async () => ({ id: "m", status: "RETRYING", createdAt: new Date() }))

    const r = await processPaymentReminders()

    expect(r).toMatchObject({ retryScheduled: 1, errors: 0, sent: 0 })
    expect(r.details).toContainEqual(expect.stringContaining("Retry scheduled reminder_1d for L-001 via sms+whatsapp"))
    expect(r.details.join("\n")).not.toContain("Skip duplicate")
    expect(loanNoteCreateMock).not.toHaveBeenCalled()
  })

  it("a row an earlier run created that is still queued stays a duplicate", async () => {
    sendMessageMock.mockImplementation(async () => ({ id: "m", status: "QUEUED", createdAt: new Date(Date.now() - 60_000) }))

    const r = await processPaymentReminders()

    expect(r.retryScheduled).toBe(0)
    expect(r.details).toContainEqual(expect.stringContaining("Skip duplicate reminder_1d for L-001 via sms+whatsapp"))
  })

  it("outside the send window the run refuses to start: nothing looked at or sent, and no tenant failed", async () => {
    sendWindow.outside = true

    const r = await processPaymentReminders()

    expect(r).toMatchObject({ skipped: "outside send window", tenants: 0, failedTenants: 0, errors: 0 })
    expect(r.details[0]).toMatch(/^Skipped: outside the 07:00-20:00 SAST dunning send window/)
    expect(ensureDpdCurrentMock).not.toHaveBeenCalled()
    expect(loanFindManyMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(triggerNotificationMock).not.toHaveBeenCalled()
  })

  // A run that started at 19:59 must stop messaging at 20:00: the window is checked per loan.
  it("the window closing mid-run stops the run: the remaining loans are deferred, not errors", async () => {
    loanFindManyMock.mockResolvedValue([loanDueIn(1), { ...loanDueIn(1), id: "loan_2", reference: "L-002" }])
    sendMessageMock.mockImplementation(async () => {
      sendWindow.outside = true
      return { id: "m", status: "SENT" }
    })

    const r = await processPaymentReminders()

    expect(new Set(sendMessageMock.mock.calls.map((c) => (c[0] as { loanId: string }).loanId))).toEqual(new Set(["loan_1"]))
    expect(r).toMatchObject({ deferred: 1, errors: 0, failedTenants: 0, sent: 1 })
    expect(r.details).toContainEqual("Deferred 1 loan(s): the 07:00-20:00 SAST dunning send window closed during this run")
  })

  // The every-loan-failed rule counts the loans TRIED: loans left untried when the window
  // closed must not dilute it, or a broken tenant would close DONE.
  it("the window closing mid-run after every loan tried has failed still fails the tenant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    loanFindManyMock.mockResolvedValue([loanDueIn(1), { ...loanDueIn(1), id: "loan_2", reference: "L-002" }])
    loanNoteFindFirstMock.mockImplementationOnce(async () => {
      sendWindow.outside = true
      throw new Error("something systemic")
    })

    const r = await processPaymentReminders()

    expect(r.failedTenants).toBe(1)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  // An overlapping run created the row a moment after this leg started and is still
  // sending it: a duplicate, not this run's retry.
  it("a still-queued row another run created after this leg started is a duplicate, not 'retry scheduled'", async () => {
    sendMessageMock.mockImplementation(async () => ({ id: "m", status: "QUEUED", createdAt: new Date(Date.now() + 1_000) }))

    const r = await processPaymentReminders()

    expect(r.retryScheduled).toBe(0)
    expect(r.details).toContainEqual(expect.stringContaining("Skip duplicate reminder_1d for L-001 via sms+whatsapp"))
  })

  it("every leg held for reconciliation writes the reconciliation-only note, and counts nothing as sent", async () => {
    sendMessageMock.mockImplementation(async () => {
      throw new MessageReconciliationRequiredError({ id: "msg_amb" } as never)
    })

    const r = await processPaymentReminders()

    expect(r).toMatchObject({ sent: 0, simulated: 0, reconciliationRequired: 1, errors: 0 })
    expect(loanNoteCreateMock.mock.calls[0][0].data.note).toMatch(
      /^Automated reminder delivery uncertain via sms\+whatsapp; held for manual reconciliation and automatic replay blocked: /,
    )
  })

  it("a known-dispatch persistence failure reports its evidence and is held, not failed", async () => {
    sendMessageMock.mockImplementation(async (a: { channel: string }) => {
      if (a.channel !== "WHATSAPP") return { id: "m", status: "SENT" }
      throw new KnownDispatchPersistenceError({
        outcome: "PROVIDER_ACCEPTED", message: { id: "msg_k" } as never, providerMessageId: "wamid-1",
        firstWriteError: new Error("w1"), recoveryWriteError: new Error("w2"), holdWriteError: new Error("w3"),
      })
    })

    const r = await processPaymentReminders()

    expect(r.errors).toBe(0)
    expect(r.details).toContainEqual(
      'Reconciliation required L-001 whatsapp: message msg_k; known evidence {"outcome":"PROVIDER_ACCEPTED","providerMessageId":"wamid-1"}; automatic replay blocked',
    )
    expect(loanNoteCreateMock.mock.calls[0][0].data.note).toContain("delivery uncertain and held for reconciliation via whatsapp")
  })
})
