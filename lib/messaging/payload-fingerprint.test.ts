import { describe, expect, it } from "vitest"
import { messagePayloadFingerprint, type MessagePayloadFingerprintInput } from "./payload-fingerprint"

const base: MessagePayloadFingerprintInput = {
  tenantId: "tenant-1",
  contactId: "contact-1",
  channel: "EMAIL",
  provider: "SMTP",
  templateId: "template-1",
  rendered: { subject: "Subject", text: "Body", html: "<p>Body</p>" },
  toValue: "synthetic@example.invalid",
  conversationId: "conversation-1",
  loanId: "loan-1",
  applicationId: "application-1",
  category: "agent_message",
  replyTo: "support@example.invalid",
  listUnsubscribeUrl: "https://example.invalid/unsubscribe?token=one",
  inReplyTo: "<inbound-1@example.invalid>",
  references: ["<root@example.invalid>", "<inbound-1@example.invalid>"],
  automaticRetry: false,
  failureOwner: "MESSAGING",
  attachments: [{
    filename: "evidence.pdf",
    contentType: "application/pdf",
    content: Buffer.from("synthetic-pdf-bytes"),
  }],
}

describe("messagePayloadFingerprint", () => {
  it("is stable for an exact request", () => {
    expect(messagePayloadFingerprint(base)).toBe(messagePayloadFingerprint({ ...base }))
    expect(messagePayloadFingerprint(base)).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    ["attachment bytes", { attachments: [{ ...base.attachments![0], content: Buffer.from("changed") }] }],
    ["attachment name", { attachments: [{ ...base.attachments![0], filename: "changed.pdf" }] }],
    ["reply-to", { replyTo: "collections@example.invalid" }],
    ["thread references", { references: ["<different@example.invalid>"] }],
    ["unsubscribe header", { listUnsubscribeUrl: "https://example.invalid/unsubscribe?token=two" }],
    ["loan linkage", { loanId: "loan-2" }],
    ["application linkage", { applicationId: "application-2" }],
    ["conversation linkage", { conversationId: "conversation-2" }],
    ["retry policy", { automaticRetry: true }],
    ["failure owner", { failureOwner: "CALLER" as const }],
  ])("changes when %s changes", (_label, changed) => {
    expect(messagePayloadFingerprint({ ...base, ...changed })).not.toBe(messagePayloadFingerprint(base))
  })
})
