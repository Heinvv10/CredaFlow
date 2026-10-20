import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const tenantFindFirstMock = vi.fn()
const loanFindManyMock = vi.fn()
const repaymentScheduleFindFirstMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const loanNoteFindFirstMock = vi.fn()
const loanNoteCreateMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const sendSmsMock = vi.fn()
const sendWhatsAppMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const triggerNotificationMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const chargesOutstandingAtMock = vi.fn()

const holds = vi.hoisted(() => ({ held: false }))
vi.mock("@/lib/collections/client-holds", () => ({ isLoanHeld: async () => holds.held }))
const ensureDpdCurrentMock = vi.fn()
const reserveOnceMock = vi.fn()
const releaseReservationMock = vi.fn()
vi.mock("@/lib/ops/cron-run-claim", () => ({
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
vi.mock("@/lib/integrations/bulksms", () => ({
  sendSms: (a: unknown) => sendSmsMock(a),
  sendWhatsApp: (a: unknown) => sendWhatsAppMock(a),
}))
vi.mock("@/lib/messaging/send", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    sendMessage: (a: unknown) => sendMessageMock(a),
  }
})
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    lookupContactByChannelValue: (...args: unknown[]) => lookupContactMock(...args),
  }
})
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
import { SendBlockedError } from "@/lib/messaging/send"
import { WABA_BODY_TEMPLATES, withSeededBrand } from "@/lib/whatsapp/template-vars"
import { extractPlaceholders } from "@/lib/whatsapp/template-components"
import { sastStartOfDay } from "@/lib/date/sast"
import { kabeloScheduleAsAudited } from "@/lib/loan/__fixtures__/fairscore-audit-schedules"

const sastDayOffset = (days: number) => new Date(sastStartOfDay(new Date()).getTime() + days * 86_400_000)

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
      id: "cl_9",
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
  const rows: Record<string, unknown> = { payment_reminder_sms: sampleSmsTpl, payment_reminder_email: emailTpl() }
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
  sendSmsMock.mockResolvedValue({ ok: true, messageId: "sms_1" })
  sendWhatsAppMock.mockResolvedValue({ ok: true, messageId: "wa_1" })
  sendMessageMock.mockResolvedValue({ id: "msg_1", status: "SENT" })
  chargesOutstandingAtMock.mockResolvedValue(0)
})

afterEach(() => {
  delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
})

describe("processPaymentReminders", () => {
  // White-label: no reminder is signed with a default name or phone.
  it("sends nothing when the lender identity is not configured", async () => {
    const { LenderIdentityError } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
    getLenderIdentityMock.mockRejectedValue(new LenderIdentityError(["collectionsPhone"]))
    loanFindManyMock.mockResolvedValue([loanDueTomorrow()])
    // Reported as the tenant's failure (the cron answers 503), not thrown: the
    // tenants after it still get their reminders.
    const result = await processPaymentReminders()
    expect(result.errors).toBe(1)
    expect(result.details.join("\n")).toContain("Tenant Acme (tenant_acme) failed")
    expect(result.details.join("\n"), "the cause stays in the server log").not.toContain("collectionsPhone")
    expect(result).toMatchObject({ tenants: 1, failedTenants: 1 })
    expect(sendSmsMock).not.toHaveBeenCalled()
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
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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

  describe("the pre-due email leg (through sendMessage on every path)", () => {
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

    it.each([7, 1, 0])("%i days before due: one email through sendMessage, as dunning, beside the direct WhatsApp/SMS legs (flag off)", async (days) => {
      loanFindManyMock.mockResolvedValue([withEmail(days)])
      const r = await processPaymentReminders()

      expect(emailCalls()).toHaveLength(1)
      const call = emailCalls()[0]
      expect(call).toMatchObject({ category: "collections", toValue: "tester@client.invalid", template: { key: "payment_reminder_email" } })
      expect(call.idempotencyKey).toMatch(/^collections:loan_1:reminder_\d+d:EMAIL:\d{4}-\d{2}-\d{2}$/)
      expect(call.vars.subject).toContain("R 1,500.00")
      expect(call.vars.text).toContain("L-001")
      expect(call.vars.html).toBe(`<p>${call.vars.text}</p>`)
      expect(sendWhatsAppMock).toHaveBeenCalledTimes(1)
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
      expect(sendWhatsAppMock, "the other legs are unaffected").toHaveBeenCalledTimes(2)
      warned.mockRestore()
    })

    it("seeds the tenant's missing default templates when the run starts, under its brand name", async () => {
      tenantConfigFindUniqueMock.mockResolvedValue({ brandName: "Beta Credit" })
      loanFindManyMock.mockResolvedValue([])
      await processPaymentReminders()
      expect(seedDefaultMessageTemplatesMock).toHaveBeenCalledWith(expect.anything(), "tenant_acme", "Beta Credit")
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

  describe("FLAG OFF (legacy path)", () => {
    it("calls sendSms + sendWhatsApp directly and writes a LoanNote", async () => {
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])

      const r = await processPaymentReminders()

      expect(r.sent).toBe(1)
      expect(r.errors).toBe(0)
      expect(sendSmsMock).toHaveBeenCalledTimes(1)
      expect(sendWhatsAppMock).toHaveBeenCalledTimes(1)
      expect(sendWhatsAppMock.mock.calls[0][0].to).toBe("0821234567")
      expect(sendMessageMock).not.toHaveBeenCalled()
      // Only the email leg's template: SMS and WhatsApp stay on the direct legacy sends.
      expect(messageTemplateFindFirstMock.mock.calls.map((c) => (c[0] as { where: { key: string } }).where.key)).toEqual(["payment_reminder_email"])
      expect(loanNoteCreateMock).toHaveBeenCalledTimes(1)
    })

    // The legacy branch used to send to `client.whatsapp ?? client.phone`, so
    // a borrower with no WhatsApp got WhatsApped on their plain phone number —
    // a delivery failure at best. Both paths now agree: no number, no leg.
    describe("send reservation (overlapping runs)", () => {
      const withWa = () => {
        const l = loanDueTomorrow()
        l.client.whatsapp = "0821234567"
        return l
      }

      it("reserves each direct send per loan, trigger and channel before it goes", async () => {
        loanFindManyMock.mockResolvedValue([withWa()])
        await processPaymentReminders()
        expect(reserveOnceMock.mock.calls.map((c) => c[0])).toEqual(["send:loan_1:reminder_1d:sms", "send:loan_1:reminder_1d:whatsapp"])
      })

      it("a send another run has reserved is not sent again", async () => {
        loanFindManyMock.mockResolvedValue([withWa()])
        reserveOnceMock.mockResolvedValue(false)
        const r = await processPaymentReminders()
        expect(sendSmsMock).not.toHaveBeenCalled()
        expect(sendWhatsAppMock).not.toHaveBeenCalled()
        expect(loanNoteCreateMock).not.toHaveBeenCalled()
        expect(r.details.join("\n")).toContain("another run already reserved this send today")
        expect(r.errors).toBe(0)
      })

      it("a send that failed gives its reservation back so the retry can send", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        loanFindManyMock.mockResolvedValue([withWa()])
        sendWhatsAppMock.mockResolvedValue({ ok: false, error: "gateway down" })
        await processPaymentReminders()
        expect(releaseReservationMock.mock.calls.map((c) => c[0])).toEqual(["send:loan_1:reminder_1d:whatsapp"])
      })

      it("a send that threw gives its reservation back too", async () => {
        loanFindManyMock.mockResolvedValue([withWa()])
        sendSmsMock.mockRejectedValue(new Error("socket hang up"))
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        const r = await processPaymentReminders()
        expect(releaseReservationMock).toHaveBeenCalledWith("send:loan_1:reminder_1d:sms")
        expect(r.failedTenants).toBe(1)
      })
    })

    it("does NOT WhatsApp the plain phone number when the client has no WhatsApp on file", async () => {
      // Default fixture: client.whatsapp = null, client.phone = "0821234567".
      const r = await processPaymentReminders()

      expect(sendWhatsAppMock).not.toHaveBeenCalled()
      expect(sendSmsMock).toHaveBeenCalledTimes(1)
      expect(r.errors).toBe(0)
      expect(r.details).toContainEqual(
        expect.stringContaining("Skipped 1 whatsapp leg(s) this run: no WhatsApp number on file"),
      )
      // SMS was dispatched, so this trigger is not counted as
      // "no leg dispatched".
      expect(r.details.some((d) => d.includes("NO leg dispatched"))).toBe(false)
    })

    it("records legacy provider dry-runs as simulated, never sent", async () => {
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "dry-run-1", simulated: true })
      sendWhatsAppMock.mockResolvedValue({ ok: true, messageId: "dry-run-2", simulated: true })

      const r = await processPaymentReminders()

      expect(r.sent).toBe(0)
      expect(r.simulated).toBe(1)
      expect(r.details).toContainEqual(expect.stringContaining("Simulated"))
      expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ note: expect.stringContaining("simulated (not sent)") }),
      }))
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
  })

  describe("FLAG ON (new path)", () => {
    beforeEach(() => {
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
    })

    it("aborts when one or both templates missing", async () => {
      messageTemplateFindFirstMock.mockResolvedValue(null)

      const r = await processPaymentReminders()

      expect(r.errors).toBe(1)
      expect(r.details[0]).toMatch(/template missing/i)
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(sendSmsMock).not.toHaveBeenCalled()
      // Should NOT have fetched loans (early-return)
      expect(loanFindManyMock).not.toHaveBeenCalled()
    })

    it("aborts when a template has statutoryOverride=true (misconfigured)", async () => {
      stubTemplates({ payment_reminder_sms: { ...sampleSmsTpl, statutoryOverride: true } })

      const r = await processPaymentReminders()

      expect(r.errors).toBe(1)
      expect(r.details[0]).toMatch(/statutoryOverride=true/i)
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it("routes through sendMessage for both channels, never calls legacy sendSms/sendWhatsApp", async () => {
      // Client has WA on file so the new path attempts both channels.
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])
      stubTemplates()
      lookupContactMock.mockResolvedValue({ id: "ct_1" })

      const r = await processPaymentReminders()

      expect(r.sent).toBe(1)
      expect(r.errors).toBe(0)
      expect(sendSmsMock).not.toHaveBeenCalled()
      expect(sendWhatsAppMock).not.toHaveBeenCalled()
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
      ["missing/inactive", { payment_reminder_overdue_3d_whatsapp: null }, /payment_reminder_overdue_3d_whatsapp missing\/inactive/],
      [
        "statutoryOverride=true",
        { payment_reminder_overdue_3d_whatsapp: { ...waTpl("payment_reminder_overdue_3d"), statutoryOverride: true } },
        /payment_reminder_overdue_3d_whatsapp has statutoryOverride=true/,
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
      expect(r.errors).toBe(1) // visible, not silent
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
      expect(messageTemplateFindFirstMock).toHaveBeenCalledTimes(2 + WA_TEMPLATE_EVENTS.length + successors)
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
      expect(r.details.some((d) => d.match(/no Contact row for 27821234567\b/))).toBe(true)
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
      expect(r.details.some((d) => d.match(/no Contact row for 27827654321@s\.whatsapp\.net/))).toBe(true)
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
      expect(r.details.some((d) => d.match(/unparseable phone/i))).toBe(true)
      expect(sendMessageMock).not.toHaveBeenCalled()
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
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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

    it("legacy path: no sendSms, WhatsApp leg still runs, note names WhatsApp only", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])

      const r = await processPaymentReminders()

      expect(sendSmsMock).not.toHaveBeenCalled()
      expect(sendWhatsAppMock).toHaveBeenCalledTimes(1)
      expect(r.sent).toBe(1)
      expect(r.errors).toBe(0) // channel off is configuration, not a fault
      expect(r.smsChannelOff).toBe(1)
      expect(r.details).toContainEqual(
        expect.stringContaining("Blocked 1 sms leg(s) this run: SMS not enabled"),
      )
      const note = loanNoteCreateMock.mock.calls[0][0].data.note as string
      expect(note).toContain("sent via whatsapp")
      expect(note).not.toContain("sms")
    })

    it("new path: sendMessage is never called with channel SMS; WhatsApp unaffected", async () => {
      process.env.BULKSMS_DRY_RUN = "true"
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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
        process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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
      process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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

    it("CHANNEL ON: today's behaviour is unchanged — SMS still dispatched", async () => {
      process.env.BULKSMS_DRY_RUN = "false"
      const loanWithWa = loanDueTomorrow()
      loanWithWa.client.whatsapp = "0821234567"
      loanFindManyMock.mockResolvedValue([loanWithWa])

      const r = await processPaymentReminders()

      expect(sendSmsMock).toHaveBeenCalledTimes(1)
      expect(sendWhatsAppMock).toHaveBeenCalledTimes(1)
      expect(r.sent).toBe(1)
      expect(r.details.some((d) => d.includes("SMS not enabled"))).toBe(false)
    })
  })
})

// Default charges. What the
// borrower must pay now is the schedule amount PLUS the default charges
// outstanding, so every figure a reminder quotes carries them. Flag off, the
// charges are 0 and every message is byte-identical to before.
describe("default charges in reminder amounts", () => {
  beforeEach(() => {
    process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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
    process.env.MESSAGING_NEW_SEND_COLLECTIONS = "true"
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
    loanFindManyMock.mockResolvedValue([{
      ...loanDueTomorrow(), nextPaymentDate: rows[3].dueDate,
      client: { ...loanDueTomorrow().client, whatsapp: "0821234567" },
    }])

    await processPaymentReminders()

    const sms = sendSmsMock.mock.calls[0]?.[0] as { message: string } | undefined
    expect(sms?.message).toContain("your loan payment of R 2,253.75 is due on")
    expect(sms?.message).not.toContain("R 0.00")
  })

  it("sends nothing when nothing is owed on the schedule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-05-25T08:00:00.000Z"))
    const paidUp = kabeloScheduleAsAudited().map((r) => ({ ...r, totalPaid: r.totalDue, status: "PAID" as const }))
    answerFrom(paidUp)
    loanFindManyMock.mockResolvedValue([{ ...loanDueTomorrow(), nextPaymentDate: paidUp[3].dueDate }])

    const r = await processPaymentReminders()

    expect(sendSmsMock).not.toHaveBeenCalled()
    expect(sendWhatsAppMock).not.toHaveBeenCalled()
    expect(r.details).toContainEqual(expect.stringContaining("nothing owed"))
  })
})
