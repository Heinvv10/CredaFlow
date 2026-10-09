import { beforeEach, describe, expect, it, vi } from "vitest"

type Row = { direction: string; bodyText: string }
const m = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  subject: "Website chat WC-ABC234" as string | null,
  lead: { firstName: "Thandi", lastName: "Mokoena", phone: "27825550002" } as { firstName: string; lastName: string; phone: string } | null,
  messages: [] as Row[],
}))
vi.mock("@/lib/email/service", () => ({ sendEmail: m.sendEmail }))
vi.mock("@/lib/prisma", () => {
  // Every message read answers with the real rows, so a body that is ever read into the mail shows up in it.
  const tx = {
    message: {
      findFirst: async (q: { where: { direction?: string } }) => m.messages.find((r) => !q.where.direction || r.direction === q.where.direction) ?? null,
      findMany: async () => m.messages,
    },
    lead: { findFirst: async () => m.lead },
    conversation: { findFirst: async () => ({ subject: m.subject }) },
  }
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  }
})

import { sendChatAlertEmail } from "./alert"

const args = { tenantId: "t1", conversationId: "conv1", to: "team@test.invalid", now: new Date("2026-09-29T10:00:00Z") }
const NOTE = "Website chat visitor, details NOT verified: Thandi Mokoena, cell +27825550002, email thandi@test.invalid. Follow up by phone.\nChat ref: WC-ABC234\nCRM lead: /crm/leads/lead1"
const sent = () => m.sendEmail.mock.calls[0][0] as { html: string; subject: string }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXTAUTH_URL", "https://app.lender.example")
  m.sendEmail.mockResolvedValue({ ok: true, providerOutcome: "ACCEPTED" })
  m.subject = "Website chat WC-ABC234"
  m.lead = { firstName: "Thandi", lastName: "Mokoena", phone: "27825550002" }
  m.messages = [
    { direction: "INTERNAL_NOTE", bodyText: NOTE },
    { direction: "OUTBOUND", bodyText: "Hi Thandi, how can I help?" },
    { direction: "INBOUND", bodyText: "MY SECRET QUESTION" },
  ]
})

describe("sendChatAlertEmail", () => {
  it("sends one mail to the alert address with the visitor's name, number, chat ref and a link to the thread", async () => {
    expect(await sendChatAlertEmail(args)).toBe("sent")
    expect(m.sendEmail).toHaveBeenCalledTimes(1)
    expect(m.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", to: "team@test.invalid", toName: "Team",
      subject: "Website chat not answered (WC-ABC234)", category: "website_chat_alert",
      redactedBodyPlaceholder: "Website chat alert for conversation conv1",
    }))
    const { html } = sent()
    expect(html).toContain("A website visitor asked for a person and nobody joined the chat.")
    expect(html).toContain("Name: Thandi Mokoena")
    expect(html).toContain("Call-back number: +27825550002")
    expect(html).toContain("Chat ref: WC-ABC234")
    expect(html).toContain('<a href="https://app.lender.example/inbox?conversationId=conv1">Open the chat</a>')
  })

  it("carries nothing from any chat message: not the question, the bot's reply, or the first note", async () => {
    await sendChatAlertEmail(args)
    const { html } = sent()
    for (const row of m.messages) expect(html).not.toContain(row.bodyText)
    for (const fragment of ["SECRET", "how can I help", "thandi@test.invalid", "NOT verified", "/crm/leads/"]) expect(html).not.toContain(fragment)
    // The stored copy of the body names neither the visitor nor the number.
    expect(m.sendEmail.mock.calls[0][0].redactedBodyPlaceholder).not.toMatch(/Thandi|2782/)
  })

  it("escapes a visitor-typed name in the body", async () => {
    m.lead = { firstName: "<b>x", lastName: 'O"Neil', phone: "27825550002" }
    await sendChatAlertEmail(args)
    expect(sent().html).toContain("Name: &lt;b&gt;x O&quot;Neil")
    expect(sent().html).not.toContain("<b>x")
  })

  it("keeps the visitor's name out of the subject, which EmailLog stores as sent", async () => {
    await sendChatAlertEmail(args)
    expect(sent().subject).not.toMatch(/Thandi|Mokoena/i)
    m.subject = null
    await sendChatAlertEmail(args)
    expect(m.sendEmail.mock.calls[1][0].subject).toBe("Website chat not answered")
  })

  it("with no readable lead it still alerts, without a name or number", async () => {
    m.messages = [{ direction: "INBOUND", bodyText: "MY SECRET QUESTION" }]
    expect(await sendChatAlertEmail(args)).toBe("sent")
    expect(sent().subject).toBe("Website chat not answered (WC-ABC234)")
    expect(sent().html).not.toMatch(/Name:|Call-back number:/)
    expect(sent().html).toContain("/inbox?conversationId=conv1")
  })

  it("leaves the chat ref line out when the thread has no ref", async () => {
    m.subject = null
    await sendChatAlertEmail(args)
    expect(sent().html).not.toContain("Chat ref")
  })

  it("reports failed when the mail is not accepted or the send throws", async () => {
    m.sendEmail.mockResolvedValueOnce({ ok: false, error: "Email not configured", providerOutcome: "DEFINITELY_REJECTED" })
    expect(await sendChatAlertEmail(args)).toBe("failed")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    m.sendEmail.mockRejectedValueOnce(new Error("socket hang up"))
    expect(await sendChatAlertEmail(args)).toBe("failed")
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})
