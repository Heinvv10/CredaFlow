/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

// One shared tx object so the test can assert what the transaction did.
const tx = {
  emailLog: { updateMany: vi.fn() },
  loanNote: { create: vi.fn() },
  message: { findFirst: vi.fn(), create: vi.fn() },
  conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  contact: { findFirst: vi.fn() },
  contactIdentity: { findFirst: vi.fn() },
}
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: vi.fn() },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}))

import { prisma } from "@/lib/prisma"
import {
  recordEmailReply,
  recordInboundEmailMessage,
  resolveInboundEmailConversationTx,
  type InboundEmailInput,
} from "./record-inbound"

const args = { loanId: "L1", subject: "Re: your loan", fromAddress: "c@x.com", repliedAt: new Date(0) }

describe("recordEmailReply", () => {
  beforeEach(() => vi.clearAllMocks())

  it("creates a note on the first SENT→REPLIED match", async () => {
    ;(prisma.loan.findFirst as any).mockResolvedValue({ id: "L1" })
    tx.emailLog.updateMany.mockResolvedValue({ count: 1 })

    const noted = await recordEmailReply("t1", args)

    expect(noted).toBe(true)
    expect(tx.emailLog.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", referenceId: "L1", status: "SENT" },
      data: { status: "REPLIED", repliedAt: args.repliedAt },
    })
    expect(tx.loanNote.create).toHaveBeenCalledOnce()
  })

  it("is idempotent — no note when nothing transitioned (updateMany count 0)", async () => {
    ;(prisma.loan.findFirst as any).mockResolvedValue({ id: "L1" })
    tx.emailLog.updateMany.mockResolvedValue({ count: 0 })

    const noted = await recordEmailReply("t1", args)

    expect(noted).toBe(false)
    expect(tx.loanNote.create).not.toHaveBeenCalled()
  })

  it("skips (no writes) when the loan is not in this tenant", async () => {
    ;(prisma.loan.findFirst as any).mockResolvedValue(null)

    const noted = await recordEmailReply("t1", args)

    expect(noted).toBe(false)
    expect(tx.emailLog.updateMany).not.toHaveBeenCalled()
    expect(tx.loanNote.create).not.toHaveBeenCalled()
  })
})

const baseInput: InboundEmailInput = {
  provider: "SMTP",
  providerMessageId: "<reply-1@mail.example.test>",
  inReplyTo: "<out-1@lender.example>",
  references: ["<out-1@lender.example>"],
  fromAddress: "c@x.com",
  toAddress: "noreply@lender.example",
  subject: "Re: your application",
  bodyText: "thanks",
  bodyHtml: "<p>thanks</p>",
  receivedAt: new Date("2026-07-07T10:00:00Z"),
}

describe("recordInboundEmailMessage", () => {
  beforeEach(() => vi.clearAllMocks())

  it("threads onto the cited conversation when the sender owns it", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-1" } })
    tx.message.findFirst
      .mockResolvedValueOnce(null)                                                       // dedupe check: not seen
      .mockResolvedValueOnce({ conversationId: "cv-9", conversation: { contactId: "ct-1" } }) // thread match, owned by sender
    tx.message.create.mockResolvedValue({ id: "m-new" })

    const res = await recordInboundEmailMessage("t1", baseInput)

    expect(res).toEqual({ created: true, messageId: "m-new", conversationId: "cv-9" })
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: "t1", conversationId: "cv-9", channel: "EMAIL",
        direction: "INBOUND", provider: "SMTP",
        providerMessageId: "<reply-1@mail.example.test>", fromValue: "c@x.com",
        status: "DELIVERED", deliveredAt: baseInput.receivedAt,
      }),
    }))
    expect(tx.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cv-9", tenantId: "t1" },
    }))
    // lastActivityAt is the inbox queue's sort key and must move with the
    // lastInboundAt write, or an email thread stops sorting by its newest
    // traffic. Guarded on `lt` rather than set outright: IMAP polling lags the
    // mail's own receivedAt, so an outbound accepted in between is legitimately
    // newer and must not be dragged backwards.
    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cv-9",
        tenantId: "t1",
        OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: baseInput.receivedAt } }],
      },
      data: { lastActivityAt: baseInput.receivedAt },
    })
  })

  it("does NOT thread onto a cited conversation for an unknown sender (forged In-Reply-To)", async () => {
    // Sender address maps to no Contact — an attacker forging In-Reply-To to a
    // leaked outbound Message-ID must not graft their email onto a real thread.
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contact.findFirst.mockResolvedValue(null)
    tx.message.findFirst.mockResolvedValueOnce(null) // dedupe only

    const res = await recordInboundEmailMessage("t1", baseInput) // baseInput cites out-1

    expect(res).toEqual({ created: false })
    expect(tx.message.create).not.toHaveBeenCalled()
    // The outbound thread-match query is never run for an unverified sender.
    expect(tx.message.findFirst).toHaveBeenCalledTimes(1)
  })

  it("ignores a cited conversation owned by a different contact; uses the sender's own thread", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-sender" } })
    tx.message.findFirst
      .mockResolvedValueOnce(null)                                                              // dedupe
      .mockResolvedValueOnce({ conversationId: "cv-victim", conversation: { contactId: "ct-victim" } }) // cited thread owned by SOMEONE ELSE
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-sender-open" })
    tx.message.create.mockResolvedValue({ id: "m-x" })

    const res = await recordInboundEmailMessage("t1", baseInput)

    // The victim's conversation is never written to.
    expect(res.conversationId).toBe("cv-sender-open")
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ conversationId: "cv-sender-open" }),
    }))
  })

  it("reuses a non-closed (e.g. PENDING_CUSTOMER) conversation, not only OPEN", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-1" } })
    // No In-Reply-To/References → dedupe is the only message.findFirst call.
    tx.message.findFirst.mockResolvedValueOnce(null)
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-pending" })
    tx.message.create.mockResolvedValue({ id: "m-4" })

    const res = await recordInboundEmailMessage("t1", { ...baseInput, inReplyTo: null, references: [] })

    expect(res.conversationId).toBe("cv-pending")
    // One open thread per contact (lib/inbox/resolve-thread.ts): the
    // predicate is channel-free closedAt: null, not status.
    expect(tx.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ closedAt: null }),
    }))
  })

  it("labels a Graph-sourced message MSGRAPH and dedupes within that provider", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-1" } })
    tx.message.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ conversationId: "cv-9", conversation: { contactId: "ct-1" } })
    tx.message.create.mockResolvedValue({ id: "m-g" })

    await recordInboundEmailMessage("t1", { ...baseInput, provider: "MSGRAPH" })

    expect(tx.message.findFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ provider: "MSGRAPH" }),
    }))
    expect(tx.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ provider: "MSGRAPH" }),
    }))
  })

  it("falls back to the contact's open email conversation when no thread matches", async () => {
    tx.message.findFirst
      .mockResolvedValueOnce(null) // dedupe
      .mockResolvedValueOnce(null) // no thread match
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-1" } })
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-open" })
    tx.message.create.mockResolvedValue({ id: "m-2" })

    const res = await recordInboundEmailMessage("t1", { ...baseInput, inReplyTo: null, references: [] })

    expect(res.conversationId).toBe("cv-open")
    expect(tx.conversation.create).not.toHaveBeenCalled()
  })

  it("creates a new email conversation when the contact has none open", async () => {
    tx.message.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    tx.contactIdentity.findFirst.mockResolvedValue({ contact: { id: "ct-1" } })
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-fresh" })
    tx.message.create.mockResolvedValue({ id: "m-3" })

    const res = await recordInboundEmailMessage("t1", { ...baseInput, inReplyTo: null, references: [] })

    expect(tx.conversation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: "t1", contactId: "ct-1", channel: "EMAIL", status: "OPEN" }),
    }))
    expect(res.conversationId).toBe("cv-fresh")
  })

  it("skips (created:false) an unknown sender with no thread match", async () => {
    tx.message.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contact.findFirst.mockResolvedValue(null)

    const res = await recordInboundEmailMessage("t1", { ...baseInput, inReplyTo: null, references: [] })

    expect(res).toEqual({ created: false })
    expect(tx.message.create).not.toHaveBeenCalled()
  })

  it("is idempotent: a Message-ID already recorded is not re-created", async () => {
    tx.message.findFirst.mockResolvedValueOnce({ id: "existing" }) // dedupe hit

    const res = await recordInboundEmailMessage("t1", baseInput)

    expect(res).toEqual({ created: false })
    expect(tx.message.create).not.toHaveBeenCalled()
  })
})

describe("resolveInboundEmailConversationTx", () => {
  // Reset (not clear): earlier tests in this file leave queued
  // mockResolvedValueOnce entries on the shared tx that clearAllMocks does
  // not drain, and those take priority over a plain mockResolvedValue set
  // here, silently poisoning the first call. Reset drops the queue too.
  beforeEach(() => {
    tx.contactIdentity.findFirst.mockReset()
    tx.contact.findFirst.mockReset()
    tx.message.findFirst.mockReset()
    tx.conversation.findFirst.mockReset()
    tx.conversation.create.mockReset()
  })

  it("keeps the In-Reply-To match ahead of the contact fallback", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contact.findFirst.mockResolvedValue({ id: "ct1" })
    tx.message.findFirst.mockResolvedValue({
      conversationId: "cv-threaded",
      conversation: { contactId: "ct1" },
    })

    const r = await resolveInboundEmailConversationTx(tx as any, "t1", {
      inReplyTo: "<prior@acme-lending.example>",
      references: [],
      fromAddress: "person@example.test",
    })

    expect(r).toEqual({ conversationId: "cv-threaded" })
    expect(tx.conversation.findFirst).not.toHaveBeenCalled()
  })

  it("falls back to the contact's open thread with no channel predicate", async () => {
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contact.findFirst.mockResolvedValue({ id: "ct1" })
    tx.message.findFirst.mockResolvedValue(null)
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-wa" })

    const r = await resolveInboundEmailConversationTx(tx as any, "t1", {
      inReplyTo: null,
      references: [],
      fromAddress: "person@example.test",
    })

    expect(r).toEqual({ conversationId: "cv-wa" })
    const where = tx.conversation.findFirst.mock.calls[0][0].where
    expect(where).toEqual({ tenantId: "t1", contactId: "ct1", closedAt: null })
    expect(Object.keys(where)).not.toContain("channel")
  })
})
