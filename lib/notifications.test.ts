/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mocks must be hoisted BEFORE the SUT import — vi.mock factories run
// before any other import resolution in the module.

const tenantFindUniqueMock = vi.fn()
const messageTemplateFindManyMock = vi.fn()
const loanApplicationFindUniqueMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const notificationLogCreateMock = vi.fn()
const contactFindFirstMock = vi.fn()
const consentFindFirstMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: (a: unknown) => tenantFindUniqueMock(a) },
    messageTemplate: { findMany: (a: unknown) => messageTemplateFindManyMock(a) },
    loanApplication: { findUnique: (a: unknown) => loanApplicationFindUniqueMock(a) },
    loan: { findUnique: (a: unknown) => loanFindUniqueMock(a) },
    client: { findUnique: (a: unknown) => clientFindUniqueMock(a) },
    notificationLog: { create: (a: unknown) => notificationLogCreateMock(a) },
    contact: { findFirst: (a: unknown) => contactFindFirstMock(a) },
    contactConsent: { findFirst: (a: unknown) => consentFindFirstMock(a) },
    // unused by these tests but referenced by the SUT's resolveClient
    contactIdentity: { findFirst: vi.fn() },
  },
}))

vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/config/deployment-urls", () => ({ requireAppBaseUrl: () => "https://app.lender.example" }))

const sendEmailMock = vi.fn()
const sendSmsMock = vi.fn()
const sendWhatsAppMessageMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
// Default false (matches prior hardcoded behavior for every existing test).
// vi.clearAllMocks() (used throughout this file) clears call history but
// NOT a mockReturnValue override, so any test that flips this to true MUST
// flip it back — see the legacy-WA-target describe block's afterEach.
const isWaEnabledMock = vi.fn(() => false)

vi.mock("@/lib/email/service", () => ({
  sendEmail: (a: unknown) => sendEmailMock(a),
}))
vi.mock("@/lib/integrations/bulksms", () => ({
  sendSms: (a: unknown) => sendSmsMock(a),
}))
vi.mock("@/lib/whatsapp/send-for-tenant", () => ({
  // The legacy leg now goes through the tenant's configured provider rather
  // than straight to the Baileys bridge. Same target-selection behaviour, so
  // these guards keep their meaning — only the seam moved.
  sendWhatsAppForTenant: (a: unknown) => sendWhatsAppMessageMock(a),
}))
// The legacy WhatsApp leg asks the ONE WA_ENABLED parser. These suites keep the
// leg opt-in (isWaEnabledMock, default false) so the pre-existing expectations
// stay meaningful; unset env would now mean "not off".
vi.mock("@/lib/whatsapp/env-switch", () => ({ isWaEnvOff: () => !isWaEnabledMock() }))
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(),
  WA_TEMPLATES: {
    application_submitted: (firstName: string, ref: string, amount: string) =>
      `Hi ${firstName}, app ${ref} for *${amount}* received`,
    application_approved: (firstName: string, amount: string, ref: string) =>
      `Good news ${firstName}! Your loan application for *${amount}* has been *approved*. Ref: ${ref}`,
    application_declined: (firstName: string, ref: string) =>
      `Hi ${firstName}, your application *${ref}* was unsuccessful.`,
    loan_disbursed: vi.fn(),
    payment_received: (firstName: string, amount: string, balance: string) =>
      `Hi ${firstName} We've received your payment of *${amount}*. Outstanding balance: *${balance}*.`,
    payment_overdue_7d: vi.fn((firstName: string, amount: string, ref: string, phone: string) =>
      `Hi ${firstName}, your loan *${ref}* is overdue by *${amount}*. Contact ${phone}.`),
    payment_overdue_1d: vi.fn((firstName: string, amount: string, ref: string) =>
      `Hi ${firstName}, your loan *${ref}* is overdue by *${amount}*.`),
    // wrapped in vi.fn() (not a plain function like the others above) so
    // the section129_sent pinning test below can assert on call args —
    // section129_sent has no new-send flag (see NEW_SEND_FLAGS comment in
    // lib/notifications.ts), so its WA leg is only ever observable via the
    // legacy sendWhatsAppMessage path, which isWaEnabled:()=>false disables
    // in this test file.
    section129: vi.fn((firstName: string, ref: string, phone: string) =>
      `Important notice for ${firstName} — loan *${ref}*. Contact ${phone}.`),
  },
}))
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (a: unknown) => sendMessageMock(a),
  SendBlockedError: class extends Error {
    reason: string
    constructor(reason: string) {
      super(`send blocked: ${reason}`)
      this.name = "SendBlockedError"
      this.reason = reason
    }
  },
  MessageReconciliationRequiredError: class extends Error {
    messageRecord: { id: string }
    constructor(messageRecord: { id: string }) {
      super("Provider outcome requires manual reconciliation")
      this.name = "MessageReconciliationRequiredError"
      this.messageRecord = messageRecord
    }
  },
  KnownDispatchPersistenceError: class extends Error {
    outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
    messageId: string
    providerMessageId: string
    constructor(args: {
      outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
      message: { id: string }
      providerMessageId: string
    }) {
      super(args.outcome === "SIMULATED"
        ? "Simulation completed, but its terminal message status could not be persisted"
        : "Provider accepted the message, but its terminal status could not be persisted")
      this.name = "KnownDispatchPersistenceError"
      this.outcome = args.outcome
      this.messageId = args.message.id
      this.providerMessageId = args.providerMessageId
    }
  },
}))
vi.mock("@/lib/contact/identity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/contact/identity")>("@/lib/contact/identity")
  return {
    ...actual,
    // A stubbed Contact is the client's own ("cli1") unless the stub names another
    // owner: dispatch refuses a Contact that is someone else's.
    lookupContactByChannelValue: async (...args: unknown[]) => {
      const contact = (await lookupContactMock(...args)) as Record<string, unknown> | null | undefined
      return contact && !("clientId" in contact) ? { ...contact, clientId: "cli1" } : contact
    },
  }
})

import { CONTACT_NOT_CLIENTS, notificationMessageIdempotencyKey, triggerNotification } from "./notifications"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  SendBlockedError,
} from "@/lib/messaging/send"
import { WA_TEMPLATES } from "@/lib/whatsapp"
import { WABA_BODY_TEMPLATES } from "@/lib/whatsapp/template-vars"
import { extractPlaceholders } from "@/lib/whatsapp/template-components"

const baseOpts = {
  tenantId: "tn1",
  event: "application_submitted" as const,
  loanId: "app1",
  clientId: "cli1",
}

const client = {
  id: "cli1",
  firstName: "Sipho",
  lastName: "Nkosi",
  email: "sipho@example.com",
  phone: "0821234567",
  whatsapp: null as string | null,
}

describe("notificationMessageIdempotencyKey", () => {
  it("uses the durable payment id so equal receipts remain distinct", () => {
    expect(notificationMessageIdempotencyKey({
      tenantId: "tn1",
      event: "payment_received",
      loanId: "loan1",
      data: { amount: 50000, paymentId: "payment1" },
    }, "SMS")).toBe("notification:payment_received:loan1:payment1:SMS")
    expect(notificationMessageIdempotencyKey({
      tenantId: "tn1",
      event: "payment_received",
      loanId: "loan1",
      data: { amount: 50000 },
    }, "SMS")).toBeUndefined()
  })

  it("deduplicates overdue notifications per Johannesburg calendar day", () => {
    expect(notificationMessageIdempotencyKey({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "loan1",
    }, "WHATSAPP", new Date("2026-07-21T22:30:00.000Z")))
      .toBe("notification:loan_overdue:loan1:2026-07-22:WHATSAPP")
  })
})

function stdMocks() {
  clientFindUniqueMock.mockResolvedValue(client)
  loanApplicationFindUniqueMock.mockResolvedValue({
    id: "app1",
    reference: "APP-0001",
    appliedAmount: 500000,
    product: { name: "Bridging" },
  })
  tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
  notificationLogCreateMock.mockResolvedValue({})
}

describe("triggerNotification — dealer-typed contact details", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stdMocks()
  })

  it("sends nothing to a client whose dealer-typed contacts staff have not verified, and records why", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, createdByDealerId: "dealer-1", dealerContactVerifiedAt: null })
    await triggerNotification(baseOpts)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendSmsMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(notificationLogCreateMock).toHaveBeenCalledTimes(1)
    expect(notificationLogCreateMock.mock.calls[0][0]).toMatchObject({ data: { status: "blocked", error: "DEALER_CONTACT_UNVERIFIED" } })
  })
})

describe("triggerNotification — application_submitted cutover", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stdMocks()
    delete process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED
  })
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED
  })

  describe("flag OFF — legacy path", () => {
    it("calls sendEmail + sendSms, no sendMessage", async () => {
      sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

      await triggerNotification(baseOpts)

      expect(sendEmailMock).toHaveBeenCalledOnce()
      expect(sendSmsMock).toHaveBeenCalledOnce()
      expect(sendMessageMock).not.toHaveBeenCalled()
      // 3 NotificationLog writes: email + sms + whatsapp. The legacy path
      // still records a whatsapp "failed" log row when waMessage is truthy
      // even if isWaEnabled() is false (no actual WA send happened, but the
      // log row gets written). Preserved verbatim — the cutover leaves the
      // legacy path unchanged.
      expect(notificationLogCreateMock).toHaveBeenCalledTimes(3)
    })

    it("logs a legacy SMS dry-run as simulated, never sent", async () => {
      sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "dry-run-1", simulated: true })

      await triggerNotification(baseOpts)

      const smsLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "sms")
      expect(smsLog?.[0].data.status).toBe("simulated")
    })

    it("marks ambiguous legacy email, SMS, and WhatsApp outcomes review-required", async () => {
      isWaEnabledMock.mockReturnValue(true)
      sendEmailMock.mockResolvedValue({ ok: false, error: "email timeout", providerOutcome: "AMBIGUOUS" })
      sendSmsMock.mockResolvedValue({ ok: false, error: "sms timeout", providerOutcome: "AMBIGUOUS" })
      sendWhatsAppMessageMock.mockResolvedValue({
        ok: false,
        error: "whatsapp timeout",
        providerOutcome: "AMBIGUOUS",
      })

      try {
        await triggerNotification(baseOpts)
      } finally {
        isWaEnabledMock.mockReturnValue(false)
      }

      for (const channel of ["email", "sms", "whatsapp"]) {
        const log = notificationLogCreateMock.mock.calls.find(
          (call: any[]) => call[0].data.channel === channel,
        )
        expect(log?.[0].data.status).toBe("review_required")
        expect(log?.[0].data.status).not.toBe("failed")
      }
    })

    it("treats a rejected legacy provider promise as ambiguous, not definitely failed", async () => {
      sendEmailMock.mockRejectedValue(new Error("socket closed after DATA"))
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

      await triggerNotification(baseOpts)

      const emailLog = notificationLogCreateMock.mock.calls.find(
        (call: any[]) => call[0].data.channel === "email",
      )
      expect(emailLog?.[0].data).toMatchObject({
        status: "review_required",
        error: "Error: socket closed after DATA",
      })
    })

    it("retains an accepted email outcome when only the auxiliary EmailLog write failed", async () => {
      sendEmailMock.mockResolvedValue({
        ok: true,
        messageId: "em-accepted",
        providerOutcome: "ACCEPTED",
        emailLogPersistenceError: "EmailLog unavailable",
      })
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

      await triggerNotification(baseOpts)

      const emailLog = notificationLogCreateMock.mock.calls.find(
        (call: any[]) => call[0].data.channel === "email",
      )
      expect(emailLog?.[0].data).toMatchObject({
        status: "sent",
        error: "EmailLog unavailable",
      })
    })
  })

  describe("flag ON — new-send path", () => {
    beforeEach(() => {
      process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED = "true"
    })

    const okTemplates = [
      { id: "tpl-em", key: "application_submitted_email", channel: "EMAIL", statutoryOverride: false, tenantId: "tn1" },
      { id: "tpl-sm", key: "application_submitted_sms", channel: "SMS", statutoryOverride: false, tenantId: "tn1" },
      { id: "tpl-wa", key: "application_submitted_whatsapp", channel: "WHATSAPP", statutoryOverride: false, tenantId: "tn1" },
    ]

    it("routes to sendMessage per channel and writes NotificationLog rows", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

      await triggerNotification(baseOpts)

      // Legacy senders untouched
      expect(sendEmailMock).not.toHaveBeenCalled()
      expect(sendSmsMock).not.toHaveBeenCalled()
      expect(sendWhatsAppMessageMock).not.toHaveBeenCalled()

      // Email + SMS go through new-send. WhatsApp is NOT dispatched because
      // the test client has client.phone but no waMessage path can fire
      // without isWaEnabled() — in this cutover, waMessage is built but
      // only dispatched when client.phone is present (mirrors the payment-reminder policy).
      // We expect at least email + sms calls.
      expect(sendMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2)

      // Email call shape
      const emailCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "EMAIL")
      expect(emailCall).toBeDefined()
      expect(emailCall![0].toValue).toBe("sipho@example.com")
      expect(emailCall![0].vars).toHaveProperty("subject")
      expect(emailCall![0].vars).toHaveProperty("text")
      expect(emailCall![0].vars).toHaveProperty("html")
      expect(emailCall![0].idempotencyKey)
        .toBe("notification:application_submitted:app1:app1:EMAIL")
    })

    it("logs a new-pipeline SMS dry-run as simulated, never sent", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockImplementation(async (args: { channel: string }) => ({
        id: `msg-${args.channel}`,
        status: args.channel === "SMS" ? "SIMULATED" : "SENT",
      }))

      await triggerNotification(baseOpts)

      const smsLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "sms")
      expect(smsLog?.[0].data.status).toBe("simulated")
    })

    it("aborts with a failed log when a template is missing", async () => {
      // Only 2 of 3 templates present
      messageTemplateFindManyMock.mockResolvedValue([okTemplates[0], okTemplates[1]])

      await triggerNotification(baseOpts)

      // Should NOT have dispatched anything
      expect(sendMessageMock).not.toHaveBeenCalled()
      // Should have written a "failed" log row mentioning the missing template
      const logCall = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.status === "failed" && /Template.*missing/.test(c[0].data.error)
      )
      expect(logCall).toBeDefined()
    })

    it("aborts with a failed log when a template has statutoryOverride=true", async () => {
      messageTemplateFindManyMock.mockResolvedValue([
        { ...okTemplates[0], statutoryOverride: true },
        okTemplates[1],
        okTemplates[2],
      ])

      await triggerNotification(baseOpts)
      expect(sendMessageMock).not.toHaveBeenCalled()
      const logCall = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.status === "failed" && /statutoryOverride/.test(c[0].data.error)
      )
      expect(logCall).toBeDefined()
    })

    it("records SendBlockedError as 'blocked' (not 'failed') so dashboards don't false-alarm", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockImplementation((args: any) => {
        if (args.channel === "EMAIL") throw new SendBlockedError("NO_CONSENT_ON_FILE")
        return Promise.resolve({ id: "msg-1", status: "SENT" })
      })

      await triggerNotification(baseOpts)

      const blockedCall = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.channel === "email" && c[0].data.status === "blocked"
      )
      expect(blockedCall).toBeDefined()
      expect(blockedCall![0].data.error).toBe("NO_CONSENT_ON_FILE")
    })

    it("routes WA leg through client.whatsapp (NOT client.phone)", async () => {
      // client.whatsapp is set + distinct from client.phone
      const waClient = { ...client, whatsapp: "0739999999" }
      clientFindUniqueMock.mockResolvedValue(waClient)
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

      await triggerNotification(baseOpts)

      const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
      expect(waCall).toBeDefined()
      // toValue must be derived from whatsapp (0739999999 → 27739999999@s.whatsapp.net)
      expect(waCall![0].toValue).toBe("27739999999@s.whatsapp.net")
      expect(waCall![0].toValue).not.toContain("821234567") // NOT from client.phone

      // The WABA template body declares discrete named variables; send.ts
      // fills them from these vars. `body` alone renders the free-text
      // in-window send, and renderTemplate THROWS on any placeholder it cannot
      // find — so shipping the bodies without these vars fails every send for
      // this event, not just the template path.
      expect(waCall![0].vars).toMatchObject({
        firstName: expect.any(String),
        reference: expect.any(String),
        amount: expect.any(String),
      })
      expect(waCall![0].vars.body, "the free-text render still needs body").toBeTruthy()
    })

    it("skips WA leg with 'blocked' log when client.whatsapp is null", async () => {
      // baseOpts client has whatsapp=null in standard mocks
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

      await triggerNotification(baseOpts)

      const waSendCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
      expect(waSendCall).toBeUndefined()
      const waBlockedLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.channel === "whatsapp" && c[0].data.status === "blocked"
      )
      expect(waBlockedLog).toBeDefined()
      expect(waBlockedLog![0].data.error).toBe("No WhatsApp on file")
    })

    it.each([
      ["PROVIDER_ACCEPTED", "provider_accepted_db_write_failed"],
      ["SIMULATED", "simulated_db_write_failed"],
    ] as const)("preserves a %s outcome when both terminal status writes fail", async (outcome, expectedStatus) => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
        outcome,
        message: { id: "msg-1" } as any,
        providerMessageId: "provider-1",
        firstWriteError: new Error("first write failed"),
        recoveryWriteError: new Error("recovery write failed"),
        holdWriteError: new Error("hold write failed"),
      }))

      await triggerNotification(baseOpts)

      const recoveryLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.status === expectedStatus
      )
      expect(recoveryLog).toBeDefined()
      expect(recoveryLog![0].data.error).toContain("messageId=msg-1")
      expect(recoveryLog![0].data.status).not.toBe("failed")
    })

    it("records an ambiguous provider outcome as reconciliation-required and non-retryable", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockRejectedValue(new MessageReconciliationRequiredError({ id: "msg-ambiguous" } as any))

      await triggerNotification(baseOpts)

      const reconciliationLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
        c[0].data.status === "reconciliation_required"
      )
      expect(reconciliationLog).toBeDefined()
      expect(reconciliationLog![0].data.error).toContain("messageId=msg-ambiguous")
      expect(reconciliationLog![0].data.error).toContain("automatic replay blocked")
    })

    it("records an idempotent pending replay as pending, not failed or sent", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-retrying", status: "RETRYING" })

      await triggerNotification(baseOpts)

      const pendingLogs = notificationLogCreateMock.mock.calls.filter((c: any[]) =>
        c[0].data.status === "pending"
      )
      expect(pendingLogs.length).toBeGreaterThanOrEqual(1)
      expect(notificationLogCreateMock.mock.calls.some((c: any[]) =>
        c[0].data.status === "sent"
      )).toBe(false)
      expect(notificationLogCreateMock.mock.calls.some((c: any[]) =>
        c[0].data.status === "failed"
      )).toBe(false)
    })

    it("records missing-Contact-row as failed (data drift surface, not silent drop)", async () => {
      messageTemplateFindManyMock.mockResolvedValue(okTemplates)
      lookupContactMock.mockResolvedValue(null) // no Contact

      await triggerNotification(baseOpts)
      expect(sendMessageMock).not.toHaveBeenCalled()
      const failedCalls = notificationLogCreateMock.mock.calls.filter((c: any[]) =>
        c[0].data.status === "failed" && /No Contact row/.test(c[0].data.error)
      )
      expect(failedCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe("flag ON but event != application_submitted — legacy path still wins", () => {
    beforeEach(() => {
      process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED = "true"
    })

    it("does NOT cut over loan_approved on the application_submitted flag (flags are per event)", async () => {
      loanFindUniqueMock.mockResolvedValue({
        id: "ln1",
        reference: "LN-0001",
        outstandingPrincipal: 100000,
      })
      sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
      sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

      await triggerNotification({ ...baseOpts, event: "loan_approved", loanId: "ln1" })

      expect(sendEmailMock).toHaveBeenCalledOnce()
      expect(sendMessageMock).not.toHaveBeenCalled()
    })
  })
})

// ── Per-event cutover tests ───────────────────────────────────────────────────

const loanCommon = {
  id: "ln1",
  reference: "LN-0001",
  outstandingPrincipal: 100000,
}

function templatesForEvent(event: string) {
  return [
    { id: `tpl-${event}-em`, key: `${event}_email`, channel: "EMAIL", statutoryOverride: false, tenantId: "tn1" },
    { id: `tpl-${event}-sm`, key: `${event}_sms`, channel: "SMS", statutoryOverride: false, tenantId: "tn1" },
    { id: `tpl-${event}-wa`, key: `${event}_whatsapp`, channel: "WHATSAPP", statutoryOverride: false, tenantId: "tn1" },
    // loan_overdue's WhatsApp leg resolves one of two WABA rows by days
    // overdue; a Meta template is one fixed body and cannot branch.
    ...(event === "loan_overdue"
      ? ["loan_overdue_1d", "loan_overdue_7d"].map((v) => ({
          id: `tpl-${v}-wa`, key: `${v}_whatsapp`, channel: "WHATSAPP", statutoryOverride: false, tenantId: "tn1",
        }))
      : []),
  ]
}

interface EventCase {
  event: "application_declined" | "loan_approved" | "loan_disbursed" | "payment_received"
  flagEnv: string
  fixtureType: "application" | "loan"
}

const EVENT_CASES: EventCase[] = [
  { event: "application_declined", flagEnv: "MESSAGING_NEW_SEND_NOTIF_APP_DECLINED", fixtureType: "application" },
  { event: "loan_approved", flagEnv: "MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED", fixtureType: "application" },
  { event: "loan_disbursed", flagEnv: "MESSAGING_NEW_SEND_NOTIF_LOAN_DISBURSED", fixtureType: "loan" },
  { event: "payment_received", flagEnv: "MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED", fixtureType: "loan" },
]

describe.each(EVENT_CASES)("triggerNotification — $event cutover", (c) => {
  const opts = { tenantId: "tn1", event: c.event, loanId: c.fixtureType === "loan" ? "ln1" : "app1", clientId: "cli1" }

  beforeEach(() => {
    vi.clearAllMocks()
    clientFindUniqueMock.mockResolvedValue(client)
    // Union of fields needed by all application events. Each per-event
    // buildTemplate branch reads only its own subset (decisionReason for
    // application_declined; approvedAmount for loan_approved; appliedAmount
    // for application_submitted). Keep the union here so describe.each can
    // share one mock.resolvedValue across iterations without ordering issues.
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1",
      reference: "APP-0001",
      appliedAmount: 500000,
      approvedAmount: 500000,
      decisionReason: "Affordability",
      product: { name: "Bridging" },
    })
    loanFindUniqueMock.mockResolvedValue(loanCommon)
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    delete process.env[c.flagEnv]
  })
  afterEach(() => {
    delete process.env[c.flagEnv]
  })

  it("flag OFF — calls legacy sendEmail + sendSms, NOT sendMessage", async () => {
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
    sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

    await triggerNotification(opts)

    expect(sendEmailMock).toHaveBeenCalledOnce()
    expect(sendSmsMock).toHaveBeenCalledOnce()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("flag ON — routes to sendMessage per channel with correct template keys", async () => {
    process.env[c.flagEnv] = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent(c.event))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification(opts)

    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendSmsMock).not.toHaveBeenCalled()

    const emailCall = sendMessageMock.mock.calls.find((cl: any[]) => cl[0].channel === "EMAIL")
    const smsCall = sendMessageMock.mock.calls.find((cl: any[]) => cl[0].channel === "SMS")
    expect(emailCall).toBeDefined()
    expect(smsCall).toBeDefined()
    expect(emailCall![0].template.key).toBe(`${c.event}_email`)
    expect(smsCall![0].template.key).toBe(`${c.event}_sms`)
    expect(emailCall![0].category).toBe(c.event)

    // Verify the sendMessage call routes the id into the correct
    // Conversation FK column based on event semantics.
    const isApplicationEvent = ["application_submitted", "application_declined", "loan_approved"].includes(c.event)
    const sampleCall = emailCall![0]
    if (isApplicationEvent) {
      expect(sampleCall.applicationId).toBe(opts.loanId)
      expect(sampleCall.loanId).toBeUndefined()
    } else {
      expect(sampleCall.loanId).toBe(opts.loanId)
      expect(sampleCall.applicationId).toBeUndefined()
    }
  })
})

// loan_overdue is dunning and has no flag (MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE was
// retired): it always goes through sendMessage, whose consent gate, Contact check,
// Message.dunning and idempotency key the direct path never had. Its outcome names
// the legs that failed, so the collections cron and escalation can count them.
describe("triggerNotification — loan_overdue always goes through sendMessage", () => {
  const overdue = { tenantId: "tn1", event: "loan_overdue" as const, loanId: "ln1", clientId: "cli1", data: { daysOverdue: 1, amount: 25000 } }

  beforeEach(() => {
    vi.clearAllMocks()
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0821234567" })
    loanFindUniqueMock.mockResolvedValue(loanCommon)
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })
    process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE = "false"
  })
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE
  })

  it("with the old flag set to anything, it routes through sendMessage and never the direct senders", async () => {
    const outcome = await triggerNotification(overdue)

    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendSmsMock).not.toHaveBeenCalled()
    expect(sendWhatsAppMessageMock).not.toHaveBeenCalled()
    const calls = sendMessageMock.mock.calls.map((c: any[]) => [c[0].channel, c[0].template.key, c[0].category])
    expect(calls).toEqual([
      ["EMAIL", "loan_overdue_email", "loan_overdue"],
      ["SMS", "loan_overdue_sms", "loan_overdue"],
      ["WHATSAPP", "loan_overdue_1d_whatsapp", "loan_overdue"],
    ])
    expect(outcome).toEqual({ failedLegs: [] })
  })

  it("a leg the provider definitely rejected is a failed leg in the outcome", async () => {
    sendMessageMock.mockImplementation(async (a: { channel: string }) =>
      a.channel === "EMAIL" ? { id: "msg-e", status: "FAILED_PERMANENT" } : { id: "msg-1", status: "SENT" })
    const outcome = await triggerNotification(overdue)
    expect(outcome.failedLegs).toEqual(["email"])
  })

  it("a consent block or a pending retry is not a failure", async () => {
    sendMessageMock.mockImplementation(async (a: { channel: string }) => {
      if (a.channel === "EMAIL") throw new SendBlockedError("CHANNEL_OPTED_OUT")
      return { id: "msg-1", status: a.channel === "SMS" ? "RETRYING" : "SUPPRESSED_BY_CONSENT" }
    })
    const outcome = await triggerNotification(overdue)
    expect(outcome.failedLegs).toEqual([])
    const statuses = notificationLogCreateMock.mock.calls.map((c: any[]) => [c[0].data.channel, c[0].data.status])
    expect(statuses).toEqual([["email", "blocked"], ["sms", "pending"], ["whatsapp", "blocked"]])
  })

  // The client's number resolves to another person's Contact (a lead, another client): that
  // person's consent is not this client's, and they must not read this client's loan.
  it("a Contact that belongs to someone else is refused, logged failed without the number, and never sent", async () => {
    lookupContactMock.mockImplementation(async (_db: unknown, a: { channel: string }) =>
      a.channel === "WHATSAPP" ? { id: "ct-lead", clientId: null } : { id: "ct-1" })
    const outcome = await triggerNotification(overdue)

    expect(sendMessageMock.mock.calls.map((c: any[]) => c[0].channel)).toEqual(["EMAIL", "SMS"])
    expect(outcome.failedLegs).toEqual(["whatsapp"])
    const waLog = notificationLogCreateMock.mock.calls.find((c: any[]) => c[0].data.channel === "whatsapp")![0].data
    expect(waLog).toMatchObject({ status: "failed", error: CONTACT_NOT_CLIENTS })
    expect(waLog.error).not.toMatch(/0821234567|27821234567/)
  })
})

// ── WhatsApp template vars must come from the SAME
// DB-fetched entity data as email/SMS, not from opts.data (which most
// triggerNotification() call sites never populate). Before this fix,
// loan_approved / payment_received WhatsApp messages landed in /inbox
// with empty `*${var}*` gaps, e.g. "Outstanding balance: **." ─────────
describe("buildWaMessage — template variables", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
  })
  afterEach(() => {
    delete process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED
    delete process.env.MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED
    delete process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_DISBURSED
    delete process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED
    delete process.env.MESSAGING_NEW_SEND_NOTIF_APP_DECLINED
  })

  it("application_submitted WA message is DB-sourced", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1",
      reference: "APP-0099",
      appliedAmount: 300000,
      product: { name: "Bridging" },
    })
    process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("application_submitted"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification({ tenantId: "tn1", event: "application_submitted", loanId: "app1", clientId: "cli1" })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeDefined()
    const body = waCall![0].vars.body as string
    expect(body).toContain("APP-0099")
    expect(body).not.toMatch(/\*\*/)
  })

  it("application_declined WA message interpolates the real reference", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1",
      reference: "APP-0055",
      appliedAmount: 200000,
      product: { name: "Bridging" },
    })
    process.env.MESSAGING_NEW_SEND_NOTIF_APP_DECLINED = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("application_declined"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification({ tenantId: "tn1", event: "application_declined", loanId: "app1", clientId: "cli1" })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeDefined()
    expect(waCall![0].vars.body).toBe("Hi Sipho, your application *APP-0055* was unsuccessful.")
  })

  it("section129_sent WA reference flows end-to-end from data.reference", async () => {
    // section129_sent has no new-send flag (see NEW_SEND_FLAGS comment in
    // lib/notifications.ts) — always legacy path. isWaEnabled:()=>false in
    // this file's mock means sendWhatsAppMessage never actually dispatches,
    // so we assert on WA_TEMPLATES.section129's call args instead — proof
    // buildWaMessage built (not skipped) the message with the right ref.
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0099", outstandingPrincipal: 0 })

    // Mirrors app/api/loans/section129/route.ts's fixed call.
    await triggerNotification({
      tenantId: "tn1",
      event: "section129_sent",
      loanId: "ln1",
      clientId: "cli1",
      data: { reference: "LN-0099" },
    })

    expect(vi.mocked(WA_TEMPLATES.section129)).toHaveBeenCalledWith("Sipho", "LN-0099", expect.any(String))

    const missingVarsLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && /WA_VARS_MISSING/.test(c[0].data.error ?? "")
    )
    expect(missingVarsLog).toBeUndefined()
  })

  it("section129_sent WA leg skips + logs WA_VARS_MISSING when data.reference is omitted", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0099", outstandingPrincipal: 0 })

    await triggerNotification({ tenantId: "tn1", event: "section129_sent", loanId: "ln1", clientId: "cli1" })

    expect(WA_TEMPLATES.section129).not.toHaveBeenCalled()
    const missingVarsLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && c[0].data.status === "failed" && /WA_VARS_MISSING: reference/.test(c[0].data.error ?? "")
    )
    expect(missingVarsLog).toBeDefined()
  })

  it("loan_overdue WA leg interpolates amount + reference when the trigger site supplies both", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    // Mirrors escalation.ts's { daysOverdue: ctx.daysInArrears, amount: ctx.arrearsAmount }
    // and reminders.ts's { daysOverdue, amount: loan.arrearsAmount }.
    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 9, amount: 156000 },
    })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeDefined()
    const body = waCall![0].vars.body as string
    expect(body).toContain("LN-0007")
    expect(body).not.toMatch(/\*\*/) // no empty-interpolation gap

    const missingVarsLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && /WA_VARS_MISSING/.test(c[0].data.error ?? "")
    )
    expect(missingVarsLog).toBeUndefined()
  })

  it("loan_overdue WA leg skips + writes a failed NotificationLog row when a call site supplies no amount at all (defensive path — buildWaMessage must never interpolate an empty *amount*)", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 9 },
    })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeUndefined()

    const missingVarsLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && c[0].data.status === "failed" && /WA_VARS_MISSING: amount/.test(c[0].data.error ?? "")
    )
    expect(missingVarsLog).toBeDefined()
  })

  it.each([
    // reminders.ts fires loan_overdue at 1 and 3 days; escalation.ts at 60.
    [1, "loan_overdue_1d"],
    [3, "loan_overdue_1d"],
    [60, "loan_overdue_7d"],
  ] as const)("loan_overdue at %i days overdue sends the %s WABA template, with the arrears amount in rands", async (days, variant) => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    // arrearsAmount is stored in CENTS: 156000 is R1 560, not R156 000.
    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: days, amount: 156000 },
    })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall, "no WhatsApp send captured").toBeDefined()
    expect(waCall![0].template.key).toBe(`${variant}_whatsapp`)
    const vars = waCall![0].vars as Record<string, string>
    expect(vars.amount).toMatch(/^R1\s560$/)
    expect(vars.reference).toBe("LN-0007")
    if (variant === "loan_overdue_7d") expect(vars.daysOverdue).toBe(String(days))
    // Every placeholder in the registered body is supplied and non-blank —
    // otherwise send.ts drops the template and an out-of-window send fails.
    for (const p of extractPlaceholders(WABA_BODY_TEMPLATES[variant])) {
      expect((vars[p] ?? "").trim(), `${variant}: {{${p}}} not supplied`).not.toBe("")
    }
  })

  // ── duplicate-dunning suppression ──────────────────────────────────────
  //
  // The collections cron fires loan_overdue at the same offsets its OWN
  // reminder stages already cover, and both render on WhatsApp — two dunning
  // WhatsApps the same morning. The cron therefore asks for the WhatsApp leg
  // to be dropped, by reason, at those offsets.
  //
  // The leg is dropped, NOT the event: loan_overdue also carries the
  // "Payment Overdue Notice" EMAIL, which no reminder stage sends. Dropping
  // the event would silently take that email away from the borrower.
  describe("suppressWhatsAppReason", () => {
    const suppressed = {
      tenantId: "tn1",
      event: "loan_overdue" as const,
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 1, amount: 156000 },
      suppressWhatsAppReason: "the reminder_overdue_1d reminder stage already sends a WhatsApp at this offset",
    }

    it("NEW path: no WhatsApp send, email still sent, and the skip is logged as blocked with the reason", async () => {
      clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
      messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

      await triggerNotification(suppressed)

      const channels = sendMessageMock.mock.calls.map((c: any[]) => c[0].channel)
      expect(channels).not.toContain("WHATSAPP")
      expect(channels).toContain("EMAIL")

      const waLog = notificationLogCreateMock.mock.calls.find(
        (c: any[]) => c[0].data.channel === "whatsapp",
      )
      expect(waLog, "the skipped WhatsApp leg must still be recorded").toBeDefined()
      expect(waLog![0].data.status).toBe("blocked")
      expect(waLog![0].data.error).toBe(suppressed.suppressWhatsAppReason)
      // Never recorded as a fault — this is a deliberate policy skip, and recorded once.
      expect(waLog![0].data.status).not.toBe("failed")
      expect(notificationLogCreateMock.mock.calls.filter((c: any[]) => c[0].data.channel === "whatsapp")).toHaveLength(1)
    })

    it("WITHOUT the reason the WhatsApp leg is untouched — this is the 60-DPD escalation's call shape", async () => {
      // lib/collections/escalation.ts fires loan_overdue at 60 DPD and passes
      // no suppression. That stage has no reminder trigger covering it, so its
      // WhatsApp must keep going out.
      clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
      messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
      lookupContactMock.mockResolvedValue({ id: "ct-1" })
      sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

      await triggerNotification({
        tenantId: "tn1",
        event: "loan_overdue",
        loanId: "ln1",
        clientId: "cli1",
        data: { daysOverdue: 60, amount: 156000 },
      })

      const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
      expect(waCall, "the 60-DPD escalation must still WhatsApp").toBeDefined()
      expect(waCall![0].template.key).toBe("loan_overdue_7d_whatsapp")
    })
  })

  // A missing/inactive (findMany filters active:true — one case) or statutory
  // loan_overdue_1d/7d row skips ONLY the WhatsApp leg. Email and SMS must
  // still go out: those rows are new, and code deployed before the migration
  // that seeds them must not take the overdue notice down on every channel.
  it.each([
    ["missing/inactive", (rows: any[]) => rows.filter((t) => t.key !== "loan_overdue_7d_whatsapp"), /Template loan_overdue_7d_whatsapp missing/],
    [
      "statutoryOverride=true",
      (rows: any[]) => rows.map((t) => (t.key === "loan_overdue_7d_whatsapp" ? { ...t, statutoryOverride: true } : t)),
      /Template loan_overdue_7d_whatsapp has statutoryOverride=true/,
    ],
  ] as const)("loan_overdue with its 7-day row %s skips only the WhatsApp leg; email + SMS still send", async (_label, mutate, error) => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(mutate(templatesForEvent("loan_overdue")))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 60, amount: 156000 },
    })

    expect(sendMessageMock.mock.calls.map((c: any[]) => c[0].channel)).toEqual(["EMAIL", "SMS"])
    const waFailed = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && c[0].data.status === "failed" && error.test(c[0].data.error ?? "")
    )
    expect(waFailed, "WhatsApp leg must be NotificationLog'd as failed, naming the key").toBeDefined()
  })

  it("loan_overdue with a variant row missing leaves a client with no WhatsApp exactly as before", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: null })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(
      templatesForEvent("loan_overdue").filter((t) => t.key !== "loan_overdue_1d_whatsapp"),
    )
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 3, amount: 156000 },
    })

    expect(sendMessageMock.mock.calls.map((c: any[]) => c[0].channel)).toEqual(["EMAIL", "SMS"])
    const waLogs = notificationLogCreateMock.mock.calls.filter((c: any[]) => c[0].data.channel === "whatsapp")
    expect(waLogs.map((c: any[]) => [c[0].data.status, c[0].data.error])).toEqual([["blocked", "No WhatsApp on file"]])
  })

  it("loan_approved WA message carries the real reference + amount when triggerNotification is called without `data` (mirrors decide/route.ts)", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1",
      reference: "APP-0042",
      appliedAmount: 500000,
      approvedAmount: 500000,
      product: { name: "Bridging" },
    })
    process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_approved"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    // No `data` field — exactly what app/api/applications/[id]/decide/route.ts:231 sends.
    await triggerNotification({ tenantId: "tn1", event: "loan_approved", loanId: "app1", clientId: "cli1" })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeDefined()
    const body = waCall![0].vars.body as string
    expect(body).toContain("APP-0042")
    expect(body).not.toMatch(/\*\*/) // no empty-interpolation gap
  })

  it("payment_received WA message carries the DB-sourced outstanding balance when data.outstanding is omitted (mirrors payments/route.ts)", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    process.env.MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("payment_received"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    // Only `amount` is passed — exactly what app/api/payments/route.ts:132 sends.
    // `outstanding` must come from the DB fetch, not opts.data.
    await triggerNotification({
      tenantId: "tn1",
      event: "payment_received",
      loanId: "ln1",
      clientId: "cli1",
      data: { amount: 100000 },
    })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeDefined()
    const body = waCall![0].vars.body as string
    expect(body).not.toMatch(/\*\*/) // no empty-interpolation gap
  })

  it("skips the WhatsApp send, logs loudly, and writes a failed NotificationLog row when a required template var is still missing", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0739999999" })
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_DISBURSED = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_disbursed"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })

    // disburse/route.ts now supplies data.amount/dueDate (closing that
    // event's KNOWN GAP), but a caller that omits them — like this one —
    // must still skip loudly rather than send an empty-interpolation gap.
    await triggerNotification({ tenantId: "tn1", event: "loan_disbursed", loanId: "ln1", clientId: "cli1" })

    const waCall = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")
    expect(waCall).toBeUndefined()
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("event=loan_disbursed missing template var")
    )

    const missingVarsLog = notificationLogCreateMock.mock.calls.find((c: any[]) =>
      c[0].data.channel === "whatsapp" && c[0].data.status === "failed" && /WA_VARS_MISSING/.test(c[0].data.error ?? "")
    )
    expect(missingVarsLog).toBeDefined()

    consoleErrorSpy.mockRestore()
  })
})

describe("triggerNotification — legacy WA leg target selection (whatsapp ?? phone)", () => {
  // Regression pin: the legacy dispatch path (isWaEnabled()===true, no
  // new-send flag) originally sent to client.phone only. The manual
  // sendWhatsAppMessage() siblings this PR removed from decide/route.ts and
  // disburse/route.ts used client.whatsapp ?? client.phone — narrowing the
  // legacy leg to client.phone alone would have shrunk WA reach for any
  // client whose WhatsApp number differs from their primary phone.
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0042", outstandingPrincipal: 150000 })
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
    sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })
    sendWhatsAppMessageMock.mockResolvedValue({ ok: true, messageId: "wa-1" })
    isWaEnabledMock.mockReturnValue(true)
  })
  afterEach(() => {
    // Must restore — vi.clearAllMocks() does not undo mockReturnValue.
    isWaEnabledMock.mockReturnValue(false)
  })

  it("sends to client.whatsapp when set and distinct from client.phone", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, phone: "0821234567", whatsapp: "0739999999" })

    await triggerNotification({
      tenantId: "tn1",
      event: "payment_received",
      loanId: "ln1",
      clientId: "cli1",
      data: { amount: 50000 },
    })

    expect(sendWhatsAppMessageMock).toHaveBeenCalledOnce()
    expect(sendWhatsAppMessageMock.mock.calls[0][0].to).toBe("0739999999")
  })

  it("falls back to client.phone when client.whatsapp is null", async () => {
    clientFindUniqueMock.mockResolvedValue({ ...client, phone: "0821234567", whatsapp: null })

    await triggerNotification({
      tenantId: "tn1",
      event: "payment_received",
      loanId: "ln1",
      clientId: "cli1",
      data: { amount: 50000 },
    })

    expect(sendWhatsAppMessageMock).toHaveBeenCalledOnce()
    expect(sendWhatsAppMessageMock.mock.calls[0][0].to).toBe("0821234567")
  })
})

describe("loan_overdue email — carries the payment reference (#424)", () => {
  // The overdue notice prompts the client to pay; it must quote the loan
  // reference so the deposit reconciles as an EXACT match. It previously
  // omitted the reference entirely.
  beforeEach(() => {
    vi.clearAllMocks()
    clientFindUniqueMock.mockResolvedValue(client)
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    loanFindUniqueMock.mockResolvedValue({ id: "ln1", reference: "LN-0007", outstandingPrincipal: 250000 })
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })
  })
  afterEach(() => {
  })

  it("includes the loan reference in both the email HTML and the SMS/text body", async () => {
    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 5 },
    })

    const emailArg = sendMessageMock.mock.calls.find((c: any[]) => c[0].channel === "EMAIL")![0].vars
    expect(emailArg.html).toContain("LN-0007")
    expect(emailArg.text).toContain("LN-0007")
  })
})

const ALL_FLAGS = [
  "MESSAGING_NEW_SEND_NOTIF_APP_DECLINED",
  "MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED",
  "MESSAGING_NEW_SEND_NOTIF_LOAN_DISBURSED",
  "MESSAGING_NEW_SEND_NOTIF_PAYMENT_RECEIVED",
]

describe("triggerNotification — per-event flag isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientFindUniqueMock.mockResolvedValue(client)
    loanFindUniqueMock.mockResolvedValue(loanCommon)
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1",
      reference: "APP-0001",
      appliedAmount: 500000,
      product: { name: "Bridging" },
    })
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    ALL_FLAGS.forEach((f) => delete process.env[f])
  })
  afterEach(() => {
    ALL_FLAGS.forEach((f) => delete process.env[f])
  })

  it("flag ON for loan_approved does NOT cut over loan_disbursed", async () => {
    process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_APPROVED = "true"
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
    sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })

    await triggerNotification({ tenantId: "tn1", event: "loan_disbursed", loanId: "ln1", clientId: "cli1" })

    expect(sendEmailMock).toHaveBeenCalledOnce()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })
})

// With BULKSMS_DRY_RUN=true SMS is off. Neither dispatch path may send anyway
// and record a `simulated` NotificationLog row (plus, on the new-send path, a
// SIMULATED Message row) for a message nobody received.
describe("triggerNotification — SMS channel off (BULKSMS_DRY_RUN=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stdMocks()
    loanFindUniqueMock.mockResolvedValue({
      ...loanCommon,
      arrearsAmount: 25000,
      nextPaymentDate: new Date("2026-08-01"),
      client,
    })
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
    sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })
    sendWhatsAppMessageMock.mockResolvedValue({ ok: true, messageId: "wa-1" })
    sendMessageMock.mockResolvedValue({ id: "msg-1", status: "SENT" })
    lookupContactMock.mockResolvedValue({ id: "ct-1" })
  })
  afterEach(() => {
    process.env.BULKSMS_DRY_RUN = "false"
    isWaEnabledMock.mockReturnValue(false)
  })

  it("legacy path: no sendSms, email still sent, sms row is `blocked` not `simulated`", async () => {
    process.env.BULKSMS_DRY_RUN = "true"

    await triggerNotification(baseOpts)

    expect(sendSmsMock).not.toHaveBeenCalled()
    expect(sendEmailMock).toHaveBeenCalledOnce()
    const smsLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "sms")
    expect(smsLog?.[0].data.status).toBe("blocked")
    expect(smsLog?.[0].data.error).toBe("SMS not enabled")
  })

  // The WhatsApp result was read out of a fixed array index. Dropping the SMS
  // leg shifts it down one, so a correct WA outcome must still be reported.
  it("legacy path: the WhatsApp leg's own outcome is still reported, not the email's", async () => {
    process.env.BULKSMS_DRY_RUN = "true"
    isWaEnabledMock.mockReturnValue(true)
    sendWhatsAppMessageMock.mockResolvedValue({ ok: false, error: "wa down", providerOutcome: "AMBIGUOUS" })

    await triggerNotification(baseOpts)

    const waLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "whatsapp")
    expect(waLog?.[0].data.error).toBe("wa down")
    const emailLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "email")
    expect(emailLog?.[0].data.status).toBe("sent")
  })

  it("loan_overdue on the new-send path still sends email + WhatsApp, never SMS", async () => {
    process.env.BULKSMS_DRY_RUN = "true"
    messageTemplateFindManyMock.mockResolvedValue(templatesForEvent("loan_overdue"))
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0821234567" })
    loanFindUniqueMock.mockResolvedValue({
      ...loanCommon,
      arrearsAmount: 25000,
      nextPaymentDate: new Date("2026-08-01"),
      client: { ...client, whatsapp: "0821234567" },
    })

    await triggerNotification({
      tenantId: "tn1",
      event: "loan_overdue",
      loanId: "ln1",
      clientId: "cli1",
      data: { daysOverdue: 1, amount: 25000 },
    })

    const channels = sendMessageMock.mock.calls.map((c: any[]) => c[0].channel)
    expect(channels).toContain("EMAIL")
    expect(channels).toContain("WHATSAPP")
    expect(channels).not.toContain("SMS")
    const smsLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "sms")
    expect(smsLog?.[0].data.status).toBe("blocked")
  })

  it("CHANNEL ON: legacy sendSms still fires", async () => {
    process.env.BULKSMS_DRY_RUN = "false"

    await triggerNotification(baseOpts)

    expect(sendSmsMock).toHaveBeenCalledOnce()
    const smsLog = notificationLogCreateMock.mock.calls.find((call: any[]) => call[0].data.channel === "sms")
    expect(smsLog?.[0].data.status).toBe("sent")
  })
})

// Item F3 widened: the gate covers every event on the legacy path, not only
// loan_overdue. section129_sent is statutory: only a BLOCKED contact stops it,
// an opt-out never does (the new-send path's statutoryOverride lane is the
// same).
describe.each([
  { event: "application_submitted", id: "app1" },
  { event: "application_declined", id: "app1" },
  { event: "loan_approved", id: "app1" },
  { event: "loan_disbursed", id: "ln1" },
  { event: "payment_received", id: "ln1" },
  { event: "section129_sent", id: "ln1" },
] as const)("legacy consent gate — $event", ({ event, id }) => {
  const statutory = event === "section129_sent"
  const trigger = () => triggerNotification({
    tenantId: "tn1",
    event,
    loanId: id,
    clientId: "cli1",
    data: { amount: 50000, daysOverdue: 1, reference: "LN-0001" },
  })
  const logFor = (channel: string) =>
    notificationLogCreateMock.mock.calls.filter((c: any[]) => c[0].data.channel === channel).map((c: any[]) => c[0].data)

  beforeEach(() => {
    vi.clearAllMocks()
    for (const flag of ALL_FLAGS) delete process.env[flag]
    delete process.env.MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED
    process.env.BULKSMS_DRY_RUN = "false"
    isWaEnabledMock.mockReturnValue(true)
    clientFindUniqueMock.mockResolvedValue({ ...client, whatsapp: "0821234567" })
    loanApplicationFindUniqueMock.mockResolvedValue({
      id: "app1", reference: "APP-0001", appliedAmount: 500000, approvedAmount: 500000,
      decisionReason: "Affordability", product: { name: "Bridging" },
    })
    loanFindUniqueMock.mockResolvedValue({ ...loanCommon, arrearsAmount: 25000, nextPaymentDate: new Date("2026-08-01"), client })
    tenantFindUniqueMock.mockResolvedValue({ id: "tn1" })
    notificationLogCreateMock.mockResolvedValue({})
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "em-1" })
    sendSmsMock.mockResolvedValue({ ok: true, messageId: "sm-1" })
    sendWhatsAppMessageMock.mockResolvedValue({ ok: true, messageId: "wa-1" })
    contactFindFirstMock.mockResolvedValue({ id: "ct-1", blockedAt: null, status: "CLIENT" })
    consentFindFirstMock.mockResolvedValue(null)
  })
  afterEach(() => {
    isWaEnabledMock.mockReturnValue(false)
  })

  it("a BLOCKED contact gets nothing and every skip is logged", async () => {
    contactFindFirstMock.mockResolvedValue({ id: "ct-1", blockedAt: new Date("2026-09-01"), status: "CLIENT" })

    await trigger()

    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendSmsMock).not.toHaveBeenCalled()
    expect(sendWhatsAppMessageMock).not.toHaveBeenCalled()
    expect(logFor("email")[0]).toMatchObject({ status: "blocked", error: "Do not contact" })
  })

  it(statutory
    ? "an opted-out contact STILL gets the statutory notice (opt-out never suppresses it)"
    : "an opted-out contact gets nothing and every skip is logged", async () => {
    consentFindFirstMock.mockResolvedValue({ status: "REVOKED" })

    await trigger()

    if (statutory) {
      expect(sendEmailMock).toHaveBeenCalledOnce()
      expect(sendWhatsAppMessageMock).toHaveBeenCalledOnce()
      expect(logFor("email")[0].status).not.toBe("blocked")
    } else {
      expect(sendEmailMock).not.toHaveBeenCalled()
      expect(sendSmsMock).not.toHaveBeenCalled()
      expect(sendWhatsAppMessageMock).not.toHaveBeenCalled()
      expect(logFor("email")[0]).toMatchObject({ status: "blocked", error: "Client opted out" })
    }
  })

  it("a contact in good standing still receives the email", async () => {
    await trigger()
    expect(sendEmailMock).toHaveBeenCalledOnce()
  })
})

