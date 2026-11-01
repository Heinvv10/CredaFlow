import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  client: { email: "a@bank.invalid", whatsapp: null as string | null } as { email: string; whatsapp: string | null } | null,
  contact: { id: "contact-1", primaryEmail: "a@bank.invalid", primaryWaJid: null } as { id: string; primaryEmail: string | null; primaryWaJid: string | null } | null,
  simulate: false,
  send: vi.fn(),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { client: { findFirst: async () => h.client }, contact: { findFirst: async () => h.contact } } }))
vi.mock("@/lib/audit", () => ({ AuditAction: { LOAN_DOCUMENT_NOTICE: "LOAN_DOCUMENT_NOTICE" }, logAudit: h.audit }))
vi.mock("@/lib/collections/section129-email", () => ({ simulatesSection129: async () => h.simulate, SECTION129_SIMULATED_NOTE: "simulated (not sent)" }))
vi.mock("@/lib/messaging/agent-message", () => ({ sendAgentMessage: h.send }))

import { deliverToBorrower, deliverySummary, operationIdFor } from "./deliver"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

const args = {
  tenantId: "t1", clientId: "c1", staff: { id: "u1", email: "o@x.invalid" }, entity: { type: "Loan" as const, id: "l1" }, what: "arrears letter",
  subject: "s", text: "t", operationId: operationIdFor("x"), category: "arrears_letter", attachments: [{ filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" }],
}

describe("deliverToBorrower", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.client = { email: "a@bank.invalid", whatsapp: null }
    h.contact = { id: "contact-1", primaryEmail: "a@bank.invalid", primaryWaJid: null }
    h.simulate = false
    h.send.mockResolvedValue({ ok: true, outcome: "sent", messageId: "m1", conversationId: "c", status: "SENT" })
  })

  it("sends the email through the one pipeline, with the PDF, the category, and the loan", async () => {
    expect(await deliverToBorrower(args)).toEqual([{ channel: "EMAIL", outcome: "sent" }])
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ channel: "EMAIL", contactId: "contact-1", category: "arrears_letter", loanId: "l1", attachments: args.attachments, agentUserId: "u1" }))
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "LOAN_DOCUMENT_NOTICE", entity: "Loan", entityId: "l1", newValue: { what: "arrears letter", legs: [{ channel: "EMAIL", outcome: "sent" }] } }))
  })

  it("on a demo stack a demo mailbox is simulated: no send, and the outcome says so", async () => {
    h.simulate = true
    const legs = await deliverToBorrower(args)
    expect(legs).toEqual([{ channel: "EMAIL", outcome: "simulated" }])
    expect(h.send).not.toHaveBeenCalled()
    expect(deliverySummary(legs)).toBe("Email: simulated (not sent)")
  })

  it("sends WhatsApp text without the attachment", async () => {
    h.client = { email: "a@bank.invalid", whatsapp: "+26658000001" }
    h.contact = { id: "contact-1", primaryEmail: "a@bank.invalid", primaryWaJid: "26658000001@s.whatsapp.net" }
    await deliverToBorrower(args)
    expect(h.send.mock.calls[1][0]).toMatchObject({ channel: "WHATSAPP" })
    expect(h.send.mock.calls[1][0]).not.toHaveProperty("attachments")
  })

  it("reports a leg the pipeline refused, and never claims it went", async () => {
    h.send.mockResolvedValue({ ok: false, reason: "SEND_BLOCKED", detail: "opted out" })
    const legs = await deliverToBorrower(args)
    expect(legs).toEqual([{ channel: "EMAIL", outcome: "not_sent", detail: "opted out" }])
    expect(deliverySummary(legs)).toBe("Email: not sent (opted out)")
  })

  it("refuses, and audits as not sent, a Contact that no longer reads as the client does: it would reach the old address", async () => {
    h.client = { email: "new@bank.invalid", whatsapp: "+26658000001" }
    h.contact = { id: "contact-1", primaryEmail: "old@bank.invalid", primaryWaJid: "26658999999@s.whatsapp.net" }
    h.simulate = true
    const legs = await deliverToBorrower(args)
    expect(legs).toEqual([
      { channel: "EMAIL", outcome: "not_sent", detail: expect.stringMatching(/does not match/) },
      { channel: "WHATSAPP", outcome: "not_sent", detail: expect.stringMatching(/does not match/) },
    ])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ newValue: expect.objectContaining({ legs }) }))
  })

  it("does not throw when the notice cannot be prepared: the document stands and the audit row says so", async () => {
    h.send.mockRejectedValue(new Error("db down"))
    const legs = await deliverToBorrower(args)
    expect(legs[0]).toMatchObject({ outcome: "not_sent" })
    expect(h.audit).toHaveBeenCalledTimes(1)
  })

  it("reports a client with no Contact", async () => {
    h.contact = null
    expect(await deliverToBorrower(args)).toEqual([{ channel: "EMAIL", outcome: "not_sent", detail: "no comms Contact on file for this client" }])
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe("operationIdFor", () => {
  it("is a valid operation id and the same for the same document", () => {
    expect(parseMessageOperationId(operationIdFor("arrears-letter:abc"))).toBe(operationIdFor("arrears-letter:abc"))
    expect(operationIdFor("a")).not.toBe(operationIdFor("b"))
  })
})
