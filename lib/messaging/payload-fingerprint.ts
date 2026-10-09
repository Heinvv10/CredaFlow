import { createHash } from "node:crypto"
import type { Channel, Provider } from "@prisma/client"
import type { EmailAttachment } from "@/lib/email/service"
import type { RenderedTemplate } from "./render"

export type MessagePayloadFingerprintInput = {
  tenantId: string
  contactId: string
  channel: Channel
  provider: Provider
  templateId: string
  rendered: RenderedTemplate
  toValue: string
  toName?: string
  conversationId?: string
  loanId?: string
  applicationId?: string
  category?: string
  replyTo?: string
  listUnsubscribeUrl?: string
  attachments?: EmailAttachment[]
  inReplyTo?: string
  references?: string[]
  automaticRetry: boolean
  failureOwner: "MESSAGING" | "CALLER"
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Fingerprint the bytes and routing metadata that define one outbound request.
 * Attachment bodies are represented by their own SHA-256 digest so the Message
 * stores no document bytes while idempotency still detects byte-level changes.
 */
export function messagePayloadFingerprint(input: MessagePayloadFingerprintInput): string {
  const canonical = {
    version: 1,
    tenantId: input.tenantId,
    contactId: input.contactId,
    channel: input.channel,
    provider: input.provider,
    templateId: input.templateId,
    subject: input.rendered.subject ?? null,
    bodyText: input.rendered.text,
    bodyHtml: input.rendered.html ?? null,
    toValue: input.toValue,
    // Conditionally spread, NOT `?? null`: adding an always-present key would
    // change the canonical bytes of every existing fingerprint and turn every
    // in-flight idempotent replay into a false conflict. Absent stays absent.
    ...(input.toName ? { toName: input.toName } : {}),
    conversationId: input.conversationId ?? null,
    loanId: input.loanId ?? null,
    applicationId: input.applicationId ?? null,
    category: input.category ?? null,
    replyTo: input.replyTo ?? null,
    listUnsubscribeUrl: input.listUnsubscribeUrl ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? [],
    automaticRetry: input.automaticRetry,
    failureOwner: input.failureOwner,
    attachments: (input.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      cid: attachment.cid ?? null,
      size: attachment.content.byteLength,
      contentSha256: sha256(attachment.content),
    })),
  }

  return sha256(JSON.stringify(canonical))
}
