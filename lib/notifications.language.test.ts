/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Which language a borrower notification goes out in: Client.preferredLanguage,
// only when the tenant has that language enabled, else English. Declined and
// Section 129 stay English whatever the preference.

const m = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  tenantConfigFindUnique: vi.fn(),
  messageTemplateFindMany: vi.fn(),
  loanApplicationFindUnique: vi.fn(),
  loanFindUnique: vi.fn(),
  clientFindUnique: vi.fn(),
  notificationLogCreate: vi.fn(),
  sendEmail: vi.fn(),
  sendWhatsApp: vi.fn(),
  sendMessage: vi.fn(),
  lookupContact: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: (a: unknown) => m.tenantFindUnique(a) },
    tenantConfig: { findUnique: (a: unknown) => m.tenantConfigFindUnique(a) },
    messageTemplate: { findMany: (a: unknown) => m.messageTemplateFindMany(a) },
    loanApplication: { findUnique: (a: unknown) => m.loanApplicationFindUnique(a) },
    loan: { findUnique: (a: unknown) => m.loanFindUnique(a) },
    client: { findUnique: (a: unknown) => m.clientFindUnique(a) },
    notificationLog: { create: (a: unknown) => m.notificationLogCreate(a) },
    contactIdentity: { findFirst: vi.fn() },
  },
}))
vi.mock("@/lib/config/identity", async () => {
  const { parseLenderIdentity } = await vi.importActual<typeof import("@/lib/config/identity")>("@/lib/config/identity")
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  return { getLenderIdentity: async () => parseLenderIdentity(VALID_LENDER_COLUMNS) }
})
vi.mock("@/lib/config/deployment-urls", () => ({
  requireAppBaseUrl: () => "https://app.lender.example",
  requirePortalBaseUrl: () => "https://portal.lender.example",
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: (a: unknown) => m.sendEmail(a) }))
vi.mock("@/lib/integrations/bulksms", () => ({ sendSms: vi.fn(async () => ({ ok: true, messageId: "sm-1" })) }))
vi.mock("@/lib/whatsapp/send-for-tenant", () => ({ sendWhatsAppForTenant: (a: unknown) => m.sendWhatsApp(a) }))
vi.mock("@/lib/whatsapp", async () => ({
  ...(await vi.importActual<typeof import("@/lib/whatsapp")>("@/lib/whatsapp")),
  isWaEnabled: () => true,
}))
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (a: unknown) => m.sendMessage(a),
  SendBlockedError: class extends Error {},
  MessageReconciliationRequiredError: class extends Error {},
  KnownDispatchPersistenceError: class extends Error {},
}))
vi.mock("@/lib/contact/identity", async () => ({
  ...(await vi.importActual<typeof import("@/lib/contact/identity")>("@/lib/contact/identity")),
  lookupContactByChannelValue: (...args: unknown[]) => m.lookupContact(...args),
}))

import { triggerNotification } from "./notifications"

const client = (preferredLanguage: string | null) => ({
  id: "cli1", firstName: "Thandi", lastName: "Mthembu", email: "thandi@example.test",
  phone: "0820000001", whatsapp: "0820000001", preferredLanguage,
})

function setup(preferredLanguage: string | null, enabled: string[]) {
  m.clientFindUnique.mockResolvedValue(client(preferredLanguage))
  m.tenantConfigFindUnique.mockResolvedValue({ enabledLanguages: enabled })
  m.loanApplicationFindUnique.mockResolvedValue({
    id: "app1", reference: "APP-0001", appliedAmount: 500_000, approvedAt: null,
    decisionReason: "Affordability", product: { name: "Personal" }, client: { email: "thandi@example.test" },
  })
  m.tenantFindUnique.mockResolvedValue({ id: "tn1" })
  m.notificationLogCreate.mockResolvedValue({})
  m.sendEmail.mockResolvedValue({ ok: true, messageId: "em-1" })
  m.sendWhatsApp.mockResolvedValue({ ok: true, messageId: "wa-1" })
}

const submitted = { tenantId: "tn1", event: "application_submitted" as const, loanId: "app1", clientId: "cli1" }

beforeEach(() => vi.clearAllMocks())

describe("legacy path: email and WhatsApp free text follow the client's language", () => {
  it("sends Afrikaans when the client prefers it and the tenant has it on", async () => {
    setup("af", ["en", "af"])
    await triggerNotification(submitted)
    const email = m.sendEmail.mock.calls[0][0]
    expect(email.subject).toBe("Jou leningsaansoek is ontvang")
    expect(email.html).toContain("Ons het jou aansoek ontvang")
    expect(email.html).not.toContain("received your application")
    expect(email.text).toContain("Beste Thandi Mthembu")
    expect(m.sendWhatsApp.mock.calls[0][0].message).toContain("Jou leningsaansoek *APP-0001*")
  })

  it.each([
    ["zu", "Isicelo sakho semalimboleko sitholakele"],
    ["xh", "Isicelo sakho semali-mboleko sifunyenwe"],
  ])("sends %s too", async (locale, subject) => {
    setup(locale, ["en", "af", "zu", "xh"])
    await triggerNotification(submitted)
    expect(m.sendEmail.mock.calls[0][0].subject).toBe(subject)
  })

  it("falls back to English when the tenant has not enabled the client's language", async () => {
    setup("af", ["en"])
    await triggerNotification(submitted)
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Your Loan Application Has Been Received")
    expect(m.sendWhatsApp.mock.calls[0][0].message).toContain("Your loan application *APP-0001*")
  })

  it("does not look the tenant up for an English (or unset) preference", async () => {
    setup(null, ["en", "af"])
    await triggerNotification(submitted)
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Your Loan Application Has Been Received")
    expect(m.tenantConfigFindUnique).not.toHaveBeenCalled()
  })

  it("keeps the declined email and WhatsApp English (NCA decline disclosure)", async () => {
    setup("zu", ["en", "zu"])
    await triggerNotification({ ...submitted, event: "application_declined" })
    expect(m.sendEmail.mock.calls[0][0].subject).toBe("Update on Your Loan Application")
    expect(m.sendEmail.mock.calls[0][0].html).toContain("National Credit Act")
    expect(m.sendWhatsApp.mock.calls[0][0].message).toContain("was unsuccessful")
  })
})

describe("new-send path: the WhatsApp template row in the client's language", () => {
  const FLAG = "MESSAGING_NEW_SEND_NOTIF_APP_SUBMITTED"
  beforeEach(() => {
    process.env[FLAG] = "true"
    m.lookupContact.mockResolvedValue({ id: "ct-1" })
    m.sendMessage.mockResolvedValue({ id: "msg-1", status: "SENT" })
  })
  afterEach(() => { delete process.env[FLAG] })

  const row = (id: string, key: string, channel: string, language = "en", active = true) =>
    ({ id, key, channel, language, active, statutoryOverride: false, tenantId: "tn1" })
  const base = [
    row("tpl-em", "application_submitted_email", "EMAIL"),
    row("tpl-sm", "application_submitted_sms", "SMS"),
    row("tpl-wa", "application_submitted_whatsapp", "WHATSAPP"),
  ]
  const waTemplateSent = () => m.sendMessage.mock.calls.find((c: any[]) => c[0].channel === "WHATSAPP")![0].template.id

  it("asks for the variant key and sends it when its language matches", async () => {
    setup("af", ["en", "af"])
    m.messageTemplateFindMany.mockResolvedValue([...base, row("tpl-wa-af", "application_submitted_whatsapp__af", "WHATSAPP", "af")])
    await triggerNotification(submitted)
    expect(m.messageTemplateFindMany.mock.calls[0][0].where.key.in).toContain("application_submitted_whatsapp__af")
    expect(waTemplateSent()).toBe("tpl-wa-af")
    // Email copy is rendered in code, so its pass-through row needs no variant.
    expect(m.sendMessage.mock.calls.find((c: any[]) => c[0].channel === "EMAIL")![0].vars.subject).toBe("Jou leningsaansoek is ontvang")
  })

  it("sends the English row when the variant's language does not agree", async () => {
    setup("af", ["en", "af"])
    m.messageTemplateFindMany.mockResolvedValue([...base, row("tpl-wa-af", "application_submitted_whatsapp__af", "WHATSAPP", "en")])
    await triggerNotification(submitted)
    expect(waTemplateSent()).toBe("tpl-wa")
  })

  it("sends the English row when no variant exists, and asks for none for an English client", async () => {
    setup("af", ["en", "af"])
    m.messageTemplateFindMany.mockResolvedValue(base)
    await triggerNotification(submitted)
    expect(waTemplateSent()).toBe("tpl-wa")

    vi.clearAllMocks()
    m.lookupContact.mockResolvedValue({ id: "ct-1" })
    m.sendMessage.mockResolvedValue({ id: "msg-1", status: "SENT" })
    setup("en", ["en", "af"])
    m.messageTemplateFindMany.mockResolvedValue(base)
    await triggerNotification(submitted)
    expect(m.messageTemplateFindMany.mock.calls[0][0].where.key.in).toEqual([
      "application_submitted_email", "application_submitted_sms", "application_submitted_whatsapp",
    ])
  })
})
